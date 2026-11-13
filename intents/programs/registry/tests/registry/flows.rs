//! The registry's instructions: organizations, indexes, buffers, versions, the head, removal, and
//! approvals, with the authority defaults and the signers that each one refuses.

use anchor_lang::Address;
use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Signer};
use registry::state::index::Index;
use registry::state::organization::OrganizationV1;
use registry::RegistryError;
use sdp_intents_program_testing::definitions;
use sdp_intents_spec::wire::{DocumentKind, SemverV1};

use crate::client::{self, IndexChange, Removal};
use crate::fixture::{write_buffer, DocumentTarget, Organization};
use crate::intents::{catalog, report};
use crate::svm::{failure, funded, send, svm, Failure, SOL};

const INTERFACE: &str = "token.transfer";
const IMPLEMENTATION: &str = "system-transfer";

fn interface_document(organization: &Organization, version: &str) -> Result<Vec<u8>, Failure> {
    let text = definitions::TOKEN_TRANSFER.replace(r#""version": "1.0.0""#, &format!(r#""version": "{version}""#));

    Ok(catalog(organization).compile_interface(&text).map_err(report)?.bytes.clone())
}

fn implementation_document(organization: &Organization, version: &str) -> Result<Vec<u8>, Failure> {
    let text = definitions::SYSTEM_TRANSFER.replace(r#""version": "1.0.0""#, &format!(r#""version": "{version}""#));
    let mut catalog = catalog(organization);
    catalog.compile_interface(definitions::TOKEN_TRANSFER).map_err(report)?;

    Ok(catalog.compile_implementation(&text).map_err(report)?.bytes.clone())
}

fn index_data(svm: &LiteSVM, index: &Address) -> Result<Vec<u8>, Failure> {
    svm.get_account(index).map(|account| account.data).ok_or_else(|| failure("the index does not exist".into()))
}

fn version(major: u16, minor: u16, patch: u16) -> SemverV1 {
    registry::state::semver(major, minor, patch)
}

fn lamports(svm: &LiteSVM, address: &Address) -> u64 {
    svm.get_account(address).map_or(0, |account| account.lamports)
}

#[test]
fn creates_an_organization_once() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let data = svm.get_account(&organization.address).unwrap().data;
    let stored: &OrganizationV1 = bytemuck::from_bytes(&data[8..]);

    assert_eq!(stored.authority, organization.authority.pubkey());
    assert_eq!(&stored.name[..usize::from(stored.name_len)], b"solana.org");

    let other = funded(&mut svm, SOL).unwrap();
    let again = client::create_organization(&other.pubkey(), "solana.org", &other.pubkey());
    assert!(send(&mut svm, &[again], &[&other]).is_err());

    let bad_name = client::create_organization(&other.pubkey(), "solana org", &other.pubkey());
    assert!(send(&mut svm, &[bad_name], &[&other]).unwrap_err().is(RegistryError::BadName));

    let mut wrong_hash = client::create_organization(&other.pubkey(), "jup.ag", &other.pubkey());
    let hash = client::name_hash("jup.ag");
    let name_at = wrong_hash.data.windows(32).position(|window| window == hash).unwrap() + 32 + 4;
    wrong_hash.data[name_at] = b'k';
    assert!(send(&mut svm, &[wrong_hash], &[&other]).unwrap_err().is(RegistryError::WrongNameHash));
}

#[test]
fn only_the_organization_authority_changes_it() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let stranger = funded(&mut svm, SOL).unwrap();

    let taken = client::set_organization_authority(&organization.address, &stranger.pubkey(), &stranger.pubkey());
    assert!(send(&mut svm, &[taken], &[&stranger]).unwrap_err().is(RegistryError::WrongAuthority));

    let given =
        client::set_organization_authority(&organization.address, &organization.authority.pubkey(), &stranger.pubkey());
    send(&mut svm, &[given], &[&organization.authority]).unwrap();

    let data = svm.get_account(&organization.address).unwrap().data;
    assert_eq!(bytemuck::from_bytes::<OrganizationV1>(&data[8..]).authority, stranger.pubkey());
}

#[test]
fn publishes_versions_in_order_and_never_moves_the_head() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let index = organization.create_interface(&mut svm, INTERFACE).unwrap();
    let newer = interface_document(&organization, "1.1.0").unwrap();
    let older = interface_document(&organization, "1.0.0").unwrap();

    let newer_version = organization.publish(&mut svm, INTERFACE, &newer, None).unwrap();
    organization.publish(&mut svm, INTERFACE, &older, None).unwrap();

    let data = index_data(&svm, &index).unwrap();
    let parsed = Index::parse(&data).unwrap();
    let versions: Vec<_> = parsed.versions.iter().map(|entry| entry.version).collect();
    assert_eq!(versions, [version(1, 0, 0), version(1, 1, 0)]);
    assert!(!parsed.header.has_head.get());
    assert_eq!(&svm.get_account(&newer_version).unwrap().data[22..], newer.as_slice());

    let republished = organization.publish(&mut svm, INTERFACE, &older, None).unwrap_err();
    assert!(republished.is(RegistryError::AlreadyPublished), "{republished}");

    let change = IndexChange { authority: organization.authority.pubkey(), organization: organization.address, index };
    send(&mut svm, &[change.set_head(&version(1, 1, 0))], &[&organization.authority]).unwrap();
    let missing = send(&mut svm, &[change.set_head(&version(2, 0, 0))], &[&organization.authority]).unwrap_err();
    assert!(missing.is(RegistryError::VersionNotPublished));

    let data = index_data(&svm, &index).unwrap();
    let parsed = Index::parse(&data).unwrap();
    assert!(parsed.header.has_head.get() && parsed.header.head == version(1, 1, 0));
}

#[test]
fn publish_refuses_a_wrong_hash_a_wrong_signer_and_another_name() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let index = organization.create_interface(&mut svm, INTERFACE).unwrap();
    let document = interface_document(&organization, "1.0.0").unwrap();
    let authority = organization.authority.pubkey();

    let buffer = write_buffer(&mut svm, &organization.authority, &document).unwrap();
    let publication = client::Publication {
        payer: authority,
        authority,
        organization: organization.address,
        index,
        buffer,
        buffer_writer: authority,
        version: client::version_address(DocumentKind::Interface, &organization.address, INTERFACE, &version(1, 0, 0)),
        interface_index: None,
    };
    let wrong_hash = send(&mut svm, &[client::publish(&publication, [7; 32])], &[&organization.authority]).unwrap_err();
    assert!(wrong_hash.is(RegistryError::WrongDocumentHash), "{wrong_hash}");

    let stranger = funded(&mut svm, 10 * SOL).unwrap();
    let foreign = organization.publish_as(&mut svm, &stranger, INTERFACE, &document, None).unwrap_err();
    assert!(foreign.is(RegistryError::WrongAuthority), "{foreign}");

    organization.create_interface(&mut svm, "vault.deposit").unwrap();
    let renamed = organization.publish(&mut svm, "vault.deposit", &document, None).unwrap_err();
    assert!(renamed.is(RegistryError::WrongDocumentId), "{renamed}");

    let buffer_rent = lamports(&svm, &buffer);
    let index_rent = lamports(&svm, &index);
    let before = lamports(&svm, &authority);
    send(&mut svm, &[client::publish(&publication, anchor_lang::sha256(&document))], &[&organization.authority])
        .unwrap();

    let paid = lamports(&svm, &publication.version) + lamports(&svm, &index) - index_rent + 5_000;
    assert!(svm.get_account(&buffer).is_none_or(|account| account.lamports == 0));
    assert_eq!(lamports(&svm, &authority), before + buffer_rent - paid);
}

#[test]
fn remove_returns_the_version_rent_keeps_the_entry_and_refuses_the_head() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let index = organization.create_interface(&mut svm, INTERFACE).unwrap();
    let first =
        organization.publish(&mut svm, INTERFACE, &interface_document(&organization, "1.0.0").unwrap(), None).unwrap();
    let second =
        organization.publish(&mut svm, INTERFACE, &interface_document(&organization, "1.1.0").unwrap(), None).unwrap();
    let change = IndexChange { authority: organization.authority.pubkey(), organization: organization.address, index };
    send(&mut svm, &[change.set_head(&version(1, 1, 0))], &[&organization.authority]).unwrap();

    let recipient = Keypair::new().pubkey();
    let removal = |version_account: Address| Removal {
        authority: organization.authority.pubkey(),
        organization: organization.address,
        index,
        version: version_account,
        recipient,
    };

    let head =
        send(&mut svm, &[client::remove(&removal(second), &version(1, 1, 0))], &[&organization.authority]).unwrap_err();
    assert!(head.is(RegistryError::RemovesHead), "{head}");

    let mismatched =
        send(&mut svm, &[client::remove(&removal(second), &version(1, 0, 0))], &[&organization.authority]).unwrap_err();
    assert!(mismatched.is(RegistryError::WrongDocumentId), "{mismatched}");

    let stranger = funded(&mut svm, SOL).unwrap();
    let theirs = Removal { authority: stranger.pubkey(), ..removal(first) };
    let refused = send(&mut svm, &[client::remove(&theirs, &version(1, 0, 0))], &[&stranger]).unwrap_err();
    assert!(refused.is(RegistryError::WrongAuthority), "{refused}");

    let index_rent = lamports(&svm, &index);
    let version_rent = lamports(&svm, &first);
    send(&mut svm, &[client::remove(&removal(first), &version(1, 0, 0))], &[&organization.authority]).unwrap();

    let data = index_data(&svm, &index).unwrap();
    let removed = Index::parse(&data).unwrap().versions.first().copied().unwrap();
    assert_eq!(Index::parse(&data).unwrap().versions.len(), 2);
    assert!(removed.removed.get() && !removed.approved.get());
    assert!(svm.get_account(&first).is_none_or(|account| account.lamports == 0));
    assert_eq!(lamports(&svm, &recipient), version_rent);
    assert_eq!(lamports(&svm, &index), index_rent);

    let again =
        send(&mut svm, &[client::remove(&removal(first), &version(1, 0, 0))], &[&organization.authority]).unwrap_err();
    assert!(again.is(RegistryError::VersionRemoved), "{again}");

    let head = send(&mut svm, &[change.set_head(&version(1, 0, 0))], &[&organization.authority]).unwrap_err();
    assert!(head.is(RegistryError::VersionRemoved), "{head}");
}

/// A removed version keeps its entry, so its id never names other bytes.
#[test]
fn a_removed_version_cannot_be_published_again() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let index = organization.create_interface(&mut svm, INTERFACE).unwrap();
    let document = interface_document(&organization, "1.0.0").unwrap();
    let first = organization.publish(&mut svm, INTERFACE, &document, None).unwrap();
    let removal = Removal {
        authority: organization.authority.pubkey(),
        organization: organization.address,
        index,
        version: first,
        recipient: Keypair::new().pubkey(),
    };
    send(&mut svm, &[client::remove(&removal, &version(1, 0, 0))], &[&organization.authority]).unwrap();

    let republished = organization.publish(&mut svm, INTERFACE, &document, None).unwrap_err();

    assert!(republished.is(RegistryError::VersionRemoved), "{republished}");
}

#[test]
fn authorities_of_default_follow_the_organization_authority() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let index = organization.create_interface(&mut svm, INTERFACE).unwrap();
    let successor = funded(&mut svm, 10 * SOL).unwrap();
    let handover = client::set_organization_authority(
        &organization.address,
        &organization.authority.pubkey(),
        &successor.pubkey(),
    );
    send(&mut svm, &[handover], &[&organization.authority]).unwrap();

    let document = interface_document(&organization, "1.0.0").unwrap();
    let old = organization.publish(&mut svm, INTERFACE, &document, None).unwrap_err();
    assert!(old.is(RegistryError::WrongAuthority), "{old}");
    organization.publish_as(&mut svm, &successor, INTERFACE, &document, None).unwrap();

    let publisher = funded(&mut svm, 10 * SOL).unwrap();
    let change = IndexChange { authority: successor.pubkey(), organization: organization.address, index };
    send(&mut svm, &[change.set_update_authority(&publisher.pubkey())], &[&successor]).unwrap();

    let next = interface_document(&organization, "1.1.0").unwrap();
    let organization_authority = organization.publish_as(&mut svm, &successor, INTERFACE, &next, None).unwrap_err();
    assert!(organization_authority.is(RegistryError::WrongAuthority), "{organization_authority}");
    organization.publish_as(&mut svm, &publisher, INTERFACE, &next, None).unwrap();

    let stolen = IndexChange { authority: successor.pubkey(), organization: organization.address, index };
    let refused = send(&mut svm, &[stolen.set_update_authority(&successor.pubkey())], &[&successor]).unwrap_err();
    assert!(refused.is(RegistryError::WrongAuthority), "{refused}");
}

/// The interface `token.transfer` 1.0.0 and the implementation `system-transfer` 1.0.0, neither
/// approved.
struct Implemented {
    svm: LiteSVM,
    organization: Organization,
    interface_index: Address,
    implementation_index: Address,
}

fn implemented() -> Result<Implemented, Failure> {
    let mut svm = svm()?;
    let organization = Organization::create(&mut svm, "solana.org")?;
    let interface_index = organization.create_interface(&mut svm, INTERFACE)?;
    organization.publish(&mut svm, INTERFACE, &interface_document(&organization, "1.0.0")?, None)?;

    let implementation_index = organization.create_implementation(&mut svm, IMPLEMENTATION, &interface_index)?;
    let document = implementation_document(&organization, "1.0.0")?;
    organization.publish(&mut svm, IMPLEMENTATION, &document, Some(interface_index))?;

    Ok(Implemented { svm, organization, interface_index, implementation_index })
}

#[test]
fn approves_implementations_and_versions_only_with_the_approve_authority() {
    let Implemented { mut svm, organization, interface_index, implementation_index } = implemented().unwrap();
    let stranger = funded(&mut svm, SOL).unwrap();
    let mut approval = organization.approval(&interface_index, &implementation_index);

    let theirs = client::Approval {
        authority: stranger.pubkey(),
        ..organization.approval(&interface_index, &implementation_index)
    };
    let refused = send(&mut svm, &[theirs.approve_implementation(&stranger.pubkey())], &[&stranger]).unwrap_err();
    assert!(refused.is(RegistryError::WrongAuthority), "{refused}");

    organization.approve(&mut svm, &approval, &version(1, 0, 0)).unwrap();
    let interface = index_data(&svm, &interface_index).unwrap();
    let implementation = index_data(&svm, &implementation_index).unwrap();
    assert!(Index::parse(&interface).unwrap().approves(&implementation_index));
    assert!(Index::parse(&implementation).unwrap().entry(&version(1, 0, 0)).unwrap().approved.get());

    let twice = send(
        &mut svm,
        &[approval.approve_implementation(&organization.authority.pubkey())],
        &[&organization.authority],
    );
    assert!(twice.unwrap_err().is(RegistryError::AlreadyApproved));

    let approver = funded(&mut svm, SOL).unwrap();
    let change = IndexChange {
        authority: organization.authority.pubkey(),
        organization: organization.address,
        index: interface_index,
    };
    send(&mut svm, &[change.set_approve_authority(&approver.pubkey())], &[&organization.authority]).unwrap();
    let old = send(&mut svm, &[approval.set_version_approval(false, &version(1, 0, 0))], &[&organization.authority]);
    assert!(old.unwrap_err().is(RegistryError::WrongAuthority));

    approval.authority = approver.pubkey();
    send(&mut svm, &[approval.set_version_approval(false, &version(1, 0, 0))], &[&approver]).unwrap();
    let implementation = index_data(&svm, &implementation_index).unwrap();
    assert!(!Index::parse(&implementation).unwrap().entry(&version(1, 0, 0)).unwrap().approved.get());

    let recipient = funded(&mut svm, SOL).unwrap().pubkey();
    let before = lamports(&svm, &interface_index);
    send(&mut svm, &[approval.unapprove_implementation(&recipient)], &[&approver]).unwrap();
    let interface = index_data(&svm, &interface_index).unwrap();
    assert!(Index::parse(&interface).unwrap().approved.is_empty());
    assert_eq!(lamports(&svm, &recipient), SOL + before - lamports(&svm, &interface_index));
}

#[test]
fn the_approval_policy_approves_new_versions_of_an_approved_implementation() {
    let Implemented { mut svm, organization, interface_index, implementation_index } = implemented().unwrap();
    let approval = organization.approval(&interface_index, &implementation_index);
    let change = IndexChange {
        authority: organization.authority.pubkey(),
        organization: organization.address,
        index: interface_index,
    };

    organization
        .publish(
            &mut svm,
            IMPLEMENTATION,
            &implementation_document(&organization, "1.0.1").unwrap(),
            Some(interface_index),
        )
        .unwrap();
    send(&mut svm, &[change.set_approval_policy(true)], &[&organization.authority]).unwrap();
    organization
        .publish(
            &mut svm,
            IMPLEMENTATION,
            &implementation_document(&organization, "1.0.2").unwrap(),
            Some(interface_index),
        )
        .unwrap();

    organization.approve(&mut svm, &approval, &version(1, 0, 0)).unwrap();
    organization
        .publish(
            &mut svm,
            IMPLEMENTATION,
            &implementation_document(&organization, "1.0.3").unwrap(),
            Some(interface_index),
        )
        .unwrap();

    let data = index_data(&svm, &implementation_index).unwrap();
    let approved: Vec<bool> = Index::parse(&data).unwrap().versions.iter().map(|entry| entry.approved.get()).collect();
    assert_eq!(approved, [true, false, false, true]);
}

/// `system-transfer` as an endpoint's instructions, at tier 2.
fn remote_document(organization: &Organization, version: &str) -> Result<Vec<u8>, Failure> {
    let text = format!(
        r#"{{
  "spec": "sdp-intents@1.0", "kind": "implementation", "id": "solana.org/system-transfer", "version": "{version}",
  "cluster": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "implements": "solana.org/token.transfer@^1",
  "message": "transfer {{inputs.amount}} of {{inputs.mint}} by an endpoint",
  "recipe": {{ "kind": "remote", "url": "https://example.invalid", "returns": "instructions" }},
  "postConditions": [{{ "invokesOnly": ["11111111111111111111111111111111"], "message": "only System instructions run" }}]
}}"#
    );
    let mut catalog = catalog(organization);
    catalog.compile_interface(definitions::TOKEN_TRANSFER).map_err(report)?;

    Ok(catalog.compile_implementation(&text).map_err(report)?.bytes.clone())
}

/// The policy carries an approval only to a version whose tier is no worse than the highest
/// approved version's, so a builder replaced by an endpoint needs its own approval.
#[test]
fn the_approval_policy_keeps_a_version_at_its_tier() {
    let Implemented { mut svm, organization, interface_index, implementation_index } = implemented().unwrap();
    let approval = organization.approval(&interface_index, &implementation_index);
    let change = IndexChange {
        authority: organization.authority.pubkey(),
        organization: organization.address,
        index: interface_index,
    };
    send(&mut svm, &[change.set_approval_policy(true)], &[&organization.authority]).unwrap();
    organization.approve(&mut svm, &approval, &version(1, 0, 0)).unwrap();

    let static_document = implementation_document(&organization, "1.0.1").unwrap();
    organization.publish(&mut svm, IMPLEMENTATION, &static_document, Some(interface_index)).unwrap();
    let remote = remote_document(&organization, "1.0.2").unwrap();
    organization.publish(&mut svm, IMPLEMENTATION, &remote, Some(interface_index)).unwrap();

    let data = index_data(&svm, &implementation_index).unwrap();
    let entries = Index::parse(&data).unwrap().versions;
    let approved: Vec<bool> = entries.iter().map(|entry| entry.approved.get()).collect();
    let tiers: Vec<u8> = entries.iter().map(|entry| entry.tier).collect();

    assert_eq!(approved, [true, true, false]);
    assert_eq!(tiers, [1, 1, 2]);
}

#[test]
fn an_implementation_must_name_a_published_interface_version() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let interface_index = organization.create_interface(&mut svm, INTERFACE).unwrap();
    organization.create_implementation(&mut svm, IMPLEMENTATION, &interface_index).unwrap();
    let document = implementation_document(&organization, "1.0.0").unwrap();

    let unpublished = organization.publish(&mut svm, IMPLEMENTATION, &document, Some(interface_index)).unwrap_err();
    assert!(unpublished.is(RegistryError::InterfaceVersionNotPublished), "{unpublished}");

    let without_interface = organization.publish(&mut svm, IMPLEMENTATION, &document, None).unwrap_err();
    assert!(without_interface.is(RegistryError::WrongAccount), "{without_interface}");
    assert_eq!(DocumentTarget::of(&document).unwrap().kind, DocumentKind::Implementation);
}

/// A deployment serves one cluster, so it refuses a record for another.
#[test]
fn publish_refuses_a_record_of_another_cluster() {
    let mut svm = svm().unwrap();
    let organization = Organization::create(&mut svm, "solana.org").unwrap();
    let interface_index = organization.create_interface(&mut svm, INTERFACE).unwrap();
    organization.publish(&mut svm, INTERFACE, &interface_document(&organization, "1.0.0").unwrap(), None).unwrap();
    organization.create_implementation(&mut svm, IMPLEMENTATION, &interface_index).unwrap();
    let devnet = definitions::SYSTEM_TRANSFER.replace("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "devnet");
    let mut catalog = catalog(&organization);
    catalog.compile_interface(definitions::TOKEN_TRANSFER).unwrap();
    let document = catalog.compile_implementation(&devnet).unwrap().bytes.clone();

    let refused = organization.publish(&mut svm, IMPLEMENTATION, &document, Some(interface_index)).unwrap_err();
    assert!(refused.is(RegistryError::WrongCluster), "{refused}");

    let mainnet = implementation_document(&organization, "1.0.0").unwrap();
    organization.publish(&mut svm, IMPLEMENTATION, &mainnet, Some(interface_index)).unwrap();
}

#[test]
fn a_buffer_takes_writes_in_range_and_returns_its_rent() {
    let mut svm = svm().unwrap();
    let writer = funded(&mut svm, SOL).unwrap();
    let start = client::write_buffer(&writer.pubkey(), 1, 4, 0, &[1, 2]);
    send(&mut svm, &[start], &[&writer]).unwrap();

    let past_end = client::write_buffer(&writer.pubkey(), 1, 4, 3, &[3, 4]);
    assert!(send(&mut svm, &[past_end], &[&writer]).unwrap_err().is(RegistryError::OutOfBuffer));

    let other_length = client::write_buffer(&writer.pubkey(), 1, 5, 2, &[3, 4]);
    assert!(send(&mut svm, &[other_length], &[&writer]).unwrap_err().is(RegistryError::WrongBuffer));

    let buffer = client::buffer_address(&writer.pubkey(), 1);
    let stranger = funded(&mut svm, SOL).unwrap();
    let theirs = send(&mut svm, &[client::close_buffer(&stranger.pubkey(), &buffer)], &[&stranger]).unwrap_err();
    assert!(theirs.is(RegistryError::WrongBuffer));

    let rent = lamports(&svm, &buffer);
    let before = lamports(&svm, &writer.pubkey());
    send(&mut svm, &[client::close_buffer(&writer.pubkey(), &buffer)], &[&writer]).unwrap();
    assert_eq!(lamports(&svm, &writer.pubkey()), before + rent - 5_000);
}
