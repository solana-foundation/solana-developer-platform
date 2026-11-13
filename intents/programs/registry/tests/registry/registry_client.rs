//! The registry client builds each instruction with the bytes and the accounts that Anchor builds,
//! and its views read the accounts that the registry writes.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::Address;
use anchor_v2_testing::Signer;
use sdp_intents_program_testing::definitions;
use sdp_intents_registry_client as registry_client;
use sdp_intents_registry_client::{IndexView, OrganizationView, RegistryInstruction};
use sdp_intents_spec::wire::{DocumentKind, PodU16, SemverV1};

use crate::client;
use crate::intents::{publish_transfer, spec_address};
use crate::svm::svm;

fn assert_same(ours: RegistryInstruction, anchor: Instruction) {
    let accounts: Vec<_> = ours
        .accounts
        .iter()
        .map(|meta| (Address::new_from_array(meta.address.0), meta.role.signer(), meta.role.writable()))
        .collect();
    let expected: Vec<_> = anchor.accounts.iter().map(|meta| (meta.pubkey, meta.is_signer, meta.is_writable)).collect();

    assert_eq!(ours.data, anchor.data);
    assert_eq!(accounts, expected);
}

fn spec(address: &Address) -> sdp_intents_spec::Address {
    spec_address(address)
}

#[test]
fn builds_the_instructions_that_anchor_builds() {
    let payer = Address::new_unique();
    let authority = Address::new_unique();
    let organization = client::organization_address("solana.org");
    let name_hash = client::name_hash("token.transfer");
    let interface_index = client::index_address(DocumentKind::Interface, &organization, "token.transfer");
    let implementation_index = client::index_address(DocumentKind::Implementation, &organization, "spl-token-transfer");
    let version = SemverV1 { major: PodU16::new(1), minor: PodU16::new(2), patch: PodU16::new(3) };

    assert_eq!(registry_client::organization_address("solana.org").unwrap(), spec(&organization));
    assert_same(
        registry_client::create_organization(&spec(&payer), "solana.org", &spec(&authority)).unwrap(),
        client::create_organization(&payer, "solana.org", &authority),
    );
    let new_interface = registry_client::NewInterface {
        payer: &spec(&payer),
        authority: &spec(&authority),
        organization: &spec(&organization),
        index: &spec(&interface_index),
    };
    assert_same(
        registry_client::create_interface(&new_interface, &name_hash, registry_client::IndexAuthorities::default()),
        client::create_interface(&payer, &authority, &organization, "token.transfer"),
    );

    let new = registry_client::NewImplementation {
        payer: &spec(&payer),
        authority: &spec(&authority),
        organization: &spec(&organization),
        interface_index: &spec(&interface_index),
        index: &spec(&implementation_index),
    };
    assert_same(
        registry_client::create_implementation(&new, &client::name_hash("spl-token-transfer"), &Default::default()),
        client::create_implementation(&payer, &authority, &organization, &interface_index, "spl-token-transfer"),
    );

    let buffer = client::buffer_address(&payer, 7);
    assert_eq!(registry_client::buffer_address(&spec(&payer), 7).unwrap(), spec(&buffer));
    assert_same(
        registry_client::write_buffer(&spec(&payer), &spec(&buffer), 7, 900, 800, &[5; 100]).unwrap(),
        client::write_buffer(&payer, 7, 900, 800, &[5; 100]),
    );

    let version_account =
        client::version_address(DocumentKind::Implementation, &organization, "spl-token-transfer", &version);
    assert_eq!(
        registry_client::version_address(
            DocumentKind::Implementation,
            &spec(&organization),
            &client::name_hash("spl-token-transfer"),
            &version
        )
        .unwrap(),
        spec(&version_account)
    );

    for interface in [None, Some(interface_index)] {
        let ours = registry_client::Publication {
            payer: spec(&payer),
            authority: spec(&authority),
            organization: spec(&organization),
            index: spec(&implementation_index),
            buffer: spec(&buffer),
            buffer_writer: spec(&payer),
            version: spec(&version_account),
            interface_index: interface.as_ref().map(spec),
        };
        let anchor = client::Publication {
            payer,
            authority,
            organization,
            index: implementation_index,
            buffer,
            buffer_writer: payer,
            version: version_account,
            interface_index: interface,
        };
        assert_same(ours.instruction(&[9; 32]), client::publish(&anchor, [9; 32]));
    }

    let ours = registry_client::Approval {
        authority: spec(&authority),
        organization: spec(&organization),
        interface_index: spec(&interface_index),
        implementation_index: spec(&implementation_index),
    };
    let anchor = client::Approval { authority, organization, interface_index, implementation_index };
    assert_same(ours.approve_implementation(&spec(&payer)), anchor.approve_implementation(&payer));
    assert_same(ours.approve_version(&version), anchor.set_version_approval(true, &version));

    let change = registry_client::IndexChange {
        authority: spec(&authority),
        organization: spec(&organization),
        index: spec(&interface_index),
    };
    let anchor_change = client::IndexChange { authority, organization, index: interface_index };
    assert_same(change.set_approval_policy(true), anchor_change.set_approval_policy(true));
    assert_same(change.set_update_authority(&spec(&payer)), anchor_change.set_update_authority(&payer));
    assert_same(change.set_approve_authority(&spec(&payer)), anchor_change.set_approve_authority(&payer));
    assert_same(change.set_head(&version), anchor_change.set_head(&version));
    assert_same(
        registry_client::set_organization_authority(&spec(&organization), &spec(&authority), &spec(&payer)),
        client::set_organization_authority(&organization, &authority, &payer),
    );
}

#[test]
fn reads_the_accounts_that_the_registry_writes() {
    let mut svm = svm().unwrap();
    let published = publish_transfer(&mut svm, definitions::SYSTEM_TRANSFER, true).unwrap();
    let accounts = &published.accounts;
    let read = |address: &Address| svm.get_account(address).unwrap().data;

    let organization = read(&published.organization.address);
    assert_eq!(organization.get(..8), Some(&registry_client::ORGANIZATION_DISCRIMINATOR[..]));
    assert_eq!(OrganizationView::parse(&organization).unwrap().name(), Ok("solana.org"));
    assert_eq!(
        OrganizationView::parse(&organization).unwrap().authority(),
        &spec(&published.organization.authority.pubkey())
    );

    let interface = read(&accounts.interface_index);
    assert_eq!(interface.get(..8), Some(&registry_client::INDEX_DISCRIMINATOR[..]));
    let interface = IndexView::parse(&interface).unwrap();
    assert!(interface.approves(&spec(&accounts.implementation_index)));
    assert!(!interface.approve_new_versions());

    let implementation = read(&accounts.implementation_index);
    let version = SemverV1 { major: PodU16::new(1), minor: PodU16::new(0), patch: PodU16::new(0) };
    let entry = IndexView::parse(&implementation).unwrap().entry(&version).unwrap();
    assert!(entry.approved && !entry.removed);

    let version_account = read(&accounts.implementation_version);
    assert_eq!(version_account.get(..8), Some(&registry_client::IMPLEMENTATION_DISCRIMINATOR[..]));
    assert_eq!(read(&accounts.interface_version).get(..8), Some(&registry_client::INTERFACE_DISCRIMINATOR[..]));
    assert_eq!(registry_client::VERSION_DOCUMENT_OFFSET, registry::state::version::FIXED_LEN);
    assert!(
        sdp_intents_spec::Implementation::parse(&version_account[registry_client::VERSION_DOCUMENT_OFFSET..]).is_ok()
    );
}
