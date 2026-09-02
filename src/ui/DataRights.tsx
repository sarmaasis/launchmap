import { go } from "../lib/nav";

export default function DataRights({ setErr }: { setErr: (s: string) => void }) {
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3>Your data</h3>
      <p className="lede">Export is JSON. Erase deletes the account, boards, and events. Type your email to confirm.</p>
      <div className="hero-actions">
        <button className="btn ghost" type="button" onClick={async () => {
          const res = await fetch("/api/export");
          const data = await res.json();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = "cairn-export.json"; a.click();
          URL.revokeObjectURL(url);
        }}>Export JSON</button>
        <button className="btn ghost" type="button" onClick={async () => {
          const email = window.prompt("Type your email to erase this account");
          if (!email) return;
          const res = await fetch("/api/account/erase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: email }) });
          const data = await res.json() as { error?: string };
          if (!res.ok) { setErr(data.error ?? "Could not erase"); return; }
          go("/");
        }}>Erase account</button>
      </div>
    </div>
  );
}
