/** Procedural SVG art for demo seed data (receipts and proof-of-delivery "photos"). */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function receiptSvg(r: {
  vendor: string;
  address: string;
  gst: string;
  invoiceNo: string;
  date: string;
  billTo: string;
  items: { desc: string; qty: number; unit: number }[];
  currency?: string;
}) {
  const cur = r.currency ?? "USD";
  const money = (n: number) => `${cur === "USD" ? "$" : ""}${n.toFixed(2)}`;
  const rows = r.items
    .map((it, i) => {
      const y = 250 + i * 34;
      return `<text x="40" y="${y}" class="t">${esc(it.desc)}</text><text x="350" y="${y}" class="t r">${it.qty}</text><text x="440" y="${y}" class="t r">${money(it.unit)}</text><text x="560" y="${y}" class="t r">${money(it.qty * it.unit)}</text>`;
    })
    .join("");
  const sub = r.items.reduce((a, it) => a + it.qty * it.unit, 0);
  const y0 = 250 + r.items.length * 34 + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${y0 + 190}" viewBox="0 0 600 ${y0 + 190}">
<style>.t{font:15px ui-monospace,Menlo,monospace;fill:#222}.b{font-weight:700}.r{text-anchor:end}.h{font:700 22px ui-sans-serif,system-ui;fill:#111}.s{font:13px ui-monospace,monospace;fill:#555}</style>
<rect width="600" height="${y0 + 190}" fill="#fbfaf6"/><rect x="0" y="0" width="600" height="8" fill="#0f766e"/>
<text x="40" y="58" class="h">${esc(r.vendor)}</text>
<text x="40" y="82" class="s">${esc(r.address)}</text><text x="40" y="102" class="s">Tax ID ${esc(r.gst)}</text>
<text x="560" y="58" class="t b r">TAX INVOICE</text><text x="560" y="82" class="s r">No. ${esc(r.invoiceNo)}</text><text x="560" y="102" class="s r">Date ${esc(r.date)}</text>
<text x="40" y="146" class="s">BILL TO</text><text x="40" y="168" class="t">${esc(r.billTo)}</text>
<line x1="40" x2="560" y1="200" y2="200" stroke="#999"/>
<text x="40" y="222" class="t b">Item</text><text x="350" y="222" class="t b r">Qty</text><text x="440" y="222" class="t b r">Rate</text><text x="560" y="222" class="t b r">Amount</text>
${rows}
<line x1="40" x2="560" y1="${y0}" y2="${y0}" stroke="#999" stroke-dasharray="4 4"/>
<text x="440" y="${y0 + 32}" class="t r">Subtotal</text><text x="560" y="${y0 + 32}" class="t r">${money(sub)}</text>
<text x="440" y="${y0 + 58}" class="t r">Tax (0% relief exempt)</text><text x="560" y="${y0 + 58}" class="t r">${money(0)}</text>
<text x="440" y="${y0 + 92}" class="t b r">TOTAL ${cur}</text><text x="560" y="${y0 + 92}" class="t b r">${money(sub)}</text>
<text x="40" y="${y0 + 150}" class="s">Goods delivered to relief site. Authorised signatory: ________</text>
</svg>`;
}

type Kind = "water" | "food" | "shelter" | "hygiene" | "medical" | "logistics";

export function photoSvg(p: { kind: Kind; caption: string; stamp: string; seed: number }) {
  let s = p.seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const sky = ["#9ec9e2", "#b7d3e6", "#a9c6d9"][p.seed % 3];
  const items: string[] = [];
  const palette: Record<Kind, string[]> = {
    water: ["#2b7bb9", "#3a8fd1", "#1f6aa5"],
    food: ["#d9c39a", "#cdb385", "#e2cfa8"],
    shelter: ["#1d4ed8", "#2563eb", "#1e40af"],
    hygiene: ["#e86f51", "#f08a5d", "#d95f43"],
    medical: ["#f4f4f5", "#e4e4e7", "#fafafa"],
    logistics: ["#a16207", "#854d0e", "#b45309"],
  };
  const cols = palette[p.kind];
  if (p.kind === "shelter") {
    for (let i = 0; i < 4; i++) {
      const x = 60 + i * 150 + rnd() * 20;
      const y = 300 + rnd() * 30;
      items.push(`<polygon points="${x},${y} ${x + 60},${y - 80} ${x + 120},${y}" fill="${cols[i % 3]}" stroke="#0b2a6b" stroke-width="2"/><rect x="${x + 50}" y="${y - 40}" width="20" height="40" fill="#0b2a6b" opacity=".6"/>`);
    }
  } else if (p.kind === "logistics") {
    items.push(`<rect x="120" y="230" width="300" height="120" rx="8" fill="#f8fafc" stroke="#334155" stroke-width="3"/><rect x="420" y="270" width="120" height="80" rx="8" fill="#0f766e"/><rect x="440" y="282" width="60" height="30" fill="#bae6fd"/><circle cx="190" cy="360" r="24" fill="#1f2937"/><circle cx="470" cy="360" r="24" fill="#1f2937"/><text x="270" y="300" font-family="system-ui" font-weight="700" font-size="22" text-anchor="middle" fill="#0f766e">RELIEF SUPPLIES</text>`);
  } else {
    const w = p.kind === "water" ? 34 : 54;
    const h = p.kind === "water" ? 52 : 40;
    for (let row = 0; row < 5; row++) {
      for (let c = 0; c < 9 - row; c++) {
        const x = 110 + c * (w + 6) + row * ((w + 6) / 2) + rnd() * 3;
        const y = 330 - row * (h + 2);
        const fill = cols[Math.floor(rnd() * 3)];
        items.push(
          p.kind === "water"
            ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="#0c4a6e"/><rect x="${x + 11}" y="${y - 7}" width="12" height="8" fill="#0c4a6e"/>`
            : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="#78350f" stroke-opacity=".5"/>${p.kind === "medical" ? `<rect x="${x + w / 2 - 4}" y="${y + 10}" width="8" height="20" fill="#dc2626"/><rect x="${x + w / 2 - 10}" y="${y + 16}" width="20" height="8" fill="#dc2626"/>` : ""}`,
        );
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="440" viewBox="0 0 640 440">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="#eef6fb"/></linearGradient></defs>
<rect width="640" height="440" fill="url(#g)"/><rect y="340" width="640" height="100" fill="#a8a29e"/><rect y="340" width="640" height="6" fill="#78716c"/>
<rect x="20" y="120" width="160" height="220" fill="#d6d3d1" opacity=".55"/><rect x="470" y="150" width="150" height="190" fill="#d6d3d1" opacity=".55"/>
${items.join("")}
<rect x="0" y="392" width="640" height="48" fill="#000" opacity=".55"/>
<text x="16" y="414" font-family="ui-monospace,monospace" font-size="14" fill="#fff">${esc(p.caption)}</text>
<text x="16" y="432" font-family="ui-monospace,monospace" font-size="12" fill="#fde68a">${esc(p.stamp)}</text>
</svg>`;
}
