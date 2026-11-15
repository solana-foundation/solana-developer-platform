import type { ListedInterface, Registry } from "@/api";
import { Code, hexDump } from "@/components/Code";
import { AddressRow, Row } from "@/components/Plan";
import { describe } from "@/errors";
import { useInterfaceVersion } from "@/queries";

/// The default address means that the index follows its organization's authority.
const FOLLOWS_ORGANIZATION = "11111111111111111111111111111111";

/// The selected interface: its index, and its definition as the registry holds it.
export function InterfaceTab({
  listed,
  organizations,
}: {
  listed: ListedInterface | null;
  organizations: Registry["organizations"];
}) {
  const read = useInterfaceVersion(listed?.id ?? null, listed?.shown ?? null);

  if (listed === null) {
    return <div className="section-sub">Select an interface to see its definition.</div>;
  }

  const organization = organizations.find((entry) => entry.name === listed.organization);
  const authority = (address: string) =>
    address === FOLLOWS_ORGANIZATION && organization !== undefined
      ? { address: organization.authority, sub: `the authority of ${listed.organization}` }
      : { address, sub: undefined };
  const update = authority(listed.updateAuthority);
  const approve = authority(listed.approveAuthority);

  return (
    <>
      <div>
        <div className="section-title">{listed.id}</div>
        <div className="section-sub">
          {listed.shown} · {listed.approveNewVersions ? "approves" : "does not approve"} new
          versions of approved implementations
        </div>
      </div>
      <div className="data-rows">
        <AddressRow label="Index" address={listed.address} />
        <AddressRow label="Update authority" address={update.address} sub={update.sub} />
        <AddressRow label="Approve authority" address={approve.address} sub={approve.sub} />
        {listed.versions.map((entry) => (
          <Row
            key={entry.version}
            label={`Version ${entry.version}`}
            value={entry.removed ? "removed" : "published"}
          />
        ))}
      </div>
      {read.data !== undefined ? (
        <>
          <div className="section-sub">
            The interface as the service decompiles it from the registry, in the format of{" "}
            <code>intents/definitions</code>.
          </div>
          <Code text={JSON.stringify(read.data.document, null, 2)} />
          <div className="section-sub">
            The document as the registry holds it, {atob(read.data.bytes).length} bytes.
          </div>
          <Code text={hexDump(read.data.bytes)} />
        </>
      ) : (
        <div className="section-sub">
          {read.error === null ? "Reading the version…" : describe(read.error)}
        </div>
      )}
    </>
  );
}
