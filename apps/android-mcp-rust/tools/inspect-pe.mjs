export function inspectPe(bytes) {
  if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Release is not a Windows PE image.");
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(pe) !== 0x4550) throw new Error("Invalid PE signature.");
  const machine = bytes.readUInt16LE(pe + 4), count = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20), optional = pe + 24;
  if (machine !== 0x8664 || bytes.readUInt16LE(optional) !== 0x20b) throw new Error("Release must be Windows x64 PE32+.");
  const sections = [];
  for (let i = 0; i < count; i++) {
    const offset = optional + optionalSize + i * 40;
    sections.push({ address: bytes.readUInt32LE(offset + 12), length: Math.max(bytes.readUInt32LE(offset + 8), bytes.readUInt32LE(offset + 16)), file: bytes.readUInt32LE(offset + 20) });
  }
  const offsetOf = (rva) => {
    const section = sections.find((entry) => rva >= entry.address && rva < entry.address + entry.length);
    if (!section) throw new Error(`PE RVA outside a section: ${rva}`);
    return section.file + rva - section.address;
  };
  const imports = [];
  const importRva = bytes.readUInt32LE(optional + 112 + 8);
  if (importRva) {
    let descriptor = offsetOf(importRva);
    for (let count = 0; count < 256; count++, descriptor += 20) {
      const nameRva = bytes.readUInt32LE(descriptor + 12);
      if (!nameRva) break;
      const start = offsetOf(nameRva), end = bytes.indexOf(0, start);
      if (end < start || end - start > 256) throw new Error("Invalid PE import name.");
      imports.push(bytes.toString("ascii", start, end));
    }
  }
  imports.sort();
  const externalRuntime = imports.filter((name) => /^(?:vcruntime|msvcp|libssl|libcrypto|libgcc|libstdc\+\+)/i.test(name));
  if (externalRuntime.length) throw new Error(`Release requires separate runtime DLLs: ${externalRuntime.join(", ")}`);
  return { machine: "x86_64", imports, separateRuntimeDlls: externalRuntime };
}
