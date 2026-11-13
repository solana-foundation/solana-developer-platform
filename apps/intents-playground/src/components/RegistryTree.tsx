import type { ListedImplementation, ListedInterface, Registry } from "@/api";

interface Props {
  registry: Registry;
  selectedInterface: string | null;
  selectedImplementation: string | null;
  showUnapproved: boolean;
  onShowUnapproved: (show: boolean) => void;
  onSelectInterface: (address: string) => void;
  onSelectImplementation: (implementation: ListedImplementation) => void;
}

/// Each organization with its interfaces, and each interface with the implementations behind it. An
/// organization's implementations of other organizations' interfaces follow its interfaces.
export function RegistryTree(props: Props) {
  const { registry, showUnapproved } = props;
  const visible = registry.implementations.filter(
    (implementation) => showUnapproved || implementation.approved
  );
  const ownInterfaces = new Set(registry.interfaces.map((listed) => listed.id));

  return (
    <aside className="sidebar">
      <div className="sb-top tree">
        <div className="sb-header">
          <div className="org-btn">
            <div className="org-avatar" />
            <span className="org-name">Intents registry</span>
          </div>
        </div>

        <nav className="nav-groups">
          {registry.organizations.map((organization) => {
            const interfaces = registry.interfaces.filter(
              (listed) => listed.organization === organization.name
            );
            const foreign = visible.filter(
              (implementation) =>
                implementation.organization === organization.name &&
                !interfaces.some((listed) => listed.id === implementation.interface) &&
                ownInterfaces.has(implementation.interface ?? "")
            );

            return (
              <div className="nav-group" key={organization.address}>
                <div className="nav-section-label">{organization.name}</div>
                {interfaces.map((listed) => (
                  <InterfaceItem
                    key={listed.address}
                    listed={listed}
                    implementations={visible.filter(
                      (implementation) => implementation.interface === listed.id
                    )}
                    {...props}
                  />
                ))}
                {foreign.map((implementation) => (
                  <ImplementationItem
                    key={implementation.address}
                    implementation={implementation}
                    {...props}
                  />
                ))}
              </div>
            );
          })}
        </nav>
      </div>

      <div className="sb-bottom">
        <label className="tree-switch">
          <span className="toggle">
            <input
              type="checkbox"
              checked={showUnapproved}
              onChange={(event) => props.onShowUnapproved(event.target.checked)}
            />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </span>
          Show unapproved implementations
        </label>
      </div>
    </aside>
  );
}

function InterfaceItem(
  props: Props & { listed: ListedInterface; implementations: ListedImplementation[] }
) {
  const { listed, implementations } = props;
  const open = props.selectedInterface === listed.address;

  return (
    <>
      <button
        type="button"
        className={`nav-item tree-item ${open ? "active open" : ""}`}
        onClick={() => props.onSelectInterface(listed.address)}
      >
        <span className="tree-name">{listed.id?.split("/")[1] ?? listed.address}</span>
        <span className="tree-version">{listed.head ?? "no head"}</span>
      </button>

      {open && (
        <div className="sub-nav">
          {implementations.map((implementation) => (
            <ImplementationItem
              key={implementation.address}
              implementation={implementation}
              {...props}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ImplementationItem(props: Props & { implementation: ListedImplementation }) {
  const { implementation } = props;
  const active = props.selectedImplementation === implementation.id;

  return (
    <button
      type="button"
      className={`sub-nav-item tree-item ${active ? "active" : ""}`}
      onClick={() => props.onSelectImplementation(implementation)}
    >
      <span className="tree-name">
        {implementation.id?.split("/")[1] ?? implementation.address}
      </span>
      {!implementation.approved && <span className="badge badge-amber">unapproved</span>}
    </button>
  );
}
