use std::{fs, path::PathBuf, process::Command};

fn main() {
  let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
  let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
  for path in [
    "src",
    "assets",
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    "package.json",
    "tools/prepare-assets.mjs",
  ] {
    println!("cargo:rerun-if-changed={}", root.join(path).display());
  }
  println!("cargo:rerun-if-env-changed=QDD_NODE");
  let node = std::env::var_os("QDD_NODE").unwrap_or_else(|| "node".into());
  let status = Command::new(node)
    .current_dir(&root)
    .arg(root.join("tools/prepare-assets.mjs"))
    .arg("--out-dir")
    .arg(&output)
    .status()
    .expect("Node 24 and pinned npm esbuild are required to prepare build assets; run npm ci");
  assert!(
    status.success(),
    "prepare build assets failed; run npm ci with pinned esbuild"
  );
  let identity = fs::read_to_string(output.join("build-id.txt")).expect("generated build identity");
  assert!(
    identity.starts_with("rust-") && identity.len() == 21,
    "invalid generated build identity"
  );
  println!("cargo:rustc-env=QDD_RUST_BUILD_ID={identity}");
}
