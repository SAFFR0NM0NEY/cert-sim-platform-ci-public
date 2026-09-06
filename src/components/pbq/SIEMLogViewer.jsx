export default function SIEMLogViewer({ lab }) {
  const events = lab.assets?.siemEvents ?? [];

  return (
    <section className="pbq-simulator-panel" aria-label="SIEM log viewer scaffold">
      <div className="pbq-simulator-header">
        <h3>SIEM/log investigation scaffold</h3>
        <p>
          Future labs can provide static log rows, filters, and selectable
          findings here. No real log sources or networks are accessed.
        </p>
      </div>

      {events.length > 0 ? (
        <div className="pbq-log-list">
          {events.map((event) => (
            <pre key={event.id}>{event.message}</pre>
          ))}
        </div>
      ) : (
        <p className="pbq-placeholder-note">
          This lab type is scaffolded for future original Security+ content.
        </p>
      )}
    </section>
  );
}
