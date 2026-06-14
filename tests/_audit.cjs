const fs = require("fs");
const dir = "c:/Users/shodi/Documents/PROJECT/Manajemen_kos/kos/src/hooks/";
for (const f of ["use-whatsapp.ts", "use-payments.ts"]) {
  const c = fs.readFileSync(dir + f, "utf8");
  console.log("===== " + f + " =====");
  const paths = new Set();
  const re = /api(Get|Post|Put|Patch|Delete)\s*(?:<[^>]*>)?\s*\(\s*([`'"])([^`'"]+)\2/g;
  let m;
  while ((m = re.exec(c))) paths.add(m[1].toUpperCase() + " " + m[3]);
  [...paths].sort().forEach((p) => console.log("  " + p));
}
