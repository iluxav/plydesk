fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("src/keyboard.m").flag("-fobjc-arc").compile("desktop_keyboard");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rerun-if-changed=src/keyboard.m");
    }
    tauri_build::build()
}
