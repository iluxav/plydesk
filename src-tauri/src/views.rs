//! Native child views (apps, their embedded pages, websites, VS Code) placed over the desktop.
//!
//! On macOS a child webview sits wherever it is put. On Linux, Tauri (2.11 and still 2.12) adds every
//! child webview to the window's vertical GtkBox, and GTK stacks it below the desktop instead of
//! placing it: the desktop shrinks to the top of the window and the app fills the rest, whatever
//! position and size it is given. So on Linux the desktop's webview moves into a GtkOverlay at start,
//! under a GtkFixed layer, and each child view moves into that layer, where plydesk places it itself.

use tauri::{Manager, Webview};

/// Moves a child view the desktop created into the layer over it (Linux; elsewhere it is already there).
#[tauri::command]
pub fn native_view_adopt(app: tauri::AppHandle, webview: Webview, label: String) -> Result<(), String> {
    crate::runtime::desktop(&webview)?;
    adopt(&child(&app, &label)?)
}

/// Places a child view over the desktop, in the desktop's logical pixels.
#[tauri::command]
pub fn native_view_place(app: tauri::AppHandle, webview: Webview, label: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    crate::runtime::desktop(&webview)?;
    place(&child(&app, &label)?, x, y, width, height)
}

/// A picture of a child view, which the desktop shows in its place while the view is hidden.
#[tauri::command]
pub async fn native_view_snapshot(app: tauri::AppHandle, webview: Webview, label: String) -> Result<String, String> {
    crate::runtime::desktop(&webview)?;
    child(&app, &label)?;
    crate::runtime::snapshot_view(&app, label).await
}

/// A child view by label; never the desktop itself, which only the window places.
fn child(app: &tauri::AppHandle, label: &str) -> Result<Webview, String> {
    if label == "main" { return Err("The desktop is not a child view".into()); }
    app.get_webview(label).ok_or_else(|| "View is closed".into())
}

#[cfg(target_os = "linux")]
pub use linux::{adopt, place, setup};

#[cfg(not(target_os = "linux"))]
pub fn setup(_desktop: &Webview) -> Result<(), String> { Ok(()) }
#[cfg(not(target_os = "linux"))]
pub fn adopt(_view: &Webview) -> Result<(), String> { Ok(()) }
#[cfg(not(target_os = "linux"))]
pub fn place(view: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    view.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    view.set_size(tauri::LogicalSize::new(width.max(1.), height.max(1.))).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
mod linux {
    use gtk::prelude::*;
    use std::cell::RefCell;
    use tauri::Webview;

    thread_local! {
        /// The layer child views live in. GTK objects belong to the main thread, and so does this:
        /// `with_webview` runs its closure there.
        static LAYER: RefCell<Option<gtk::Fixed>> = const { RefCell::new(None) };
    }

    /// Puts the desktop's webview under a layer that child views can be placed in.
    pub fn setup(desktop: &Webview) -> Result<(), String> {
        desktop.with_webview(|platform| {
            let view: gtk::Widget = platform.inner().upcast();
            let Some(parent) = view.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else { return };
            let overlay = gtk::Overlay::new();
            parent.remove(&view);
            overlay.add(&view);
            let layer = gtk::Fixed::new();
            overlay.add_overlay(&layer);
            // The layer itself takes no input, so a click outside every child view reaches the desktop;
            // the views inside it, which have windows of their own, still get theirs.
            overlay.set_overlay_pass_through(&layer, true);
            parent.pack_start(&overlay, true, true, 0);
            overlay.show_all();
            LAYER.with(|l| *l.borrow_mut() = Some(layer));
        }).map_err(|e| e.to_string())
    }

    /// Moves a child view out of the stack and into the layer, off screen until it is placed.
    pub fn adopt(view: &Webview) -> Result<(), String> {
        view.with_webview(|platform| {
            let widget: gtk::Widget = platform.inner().upcast();
            LAYER.with(|l| {
                let Some(layer) = l.borrow().clone() else { return };
                if widget.parent().as_ref() == Some(layer.upcast_ref()) { return; }
                if let Some(parent) = widget.parent().and_then(|p| p.downcast::<gtk::Container>().ok()) { parent.remove(&widget); }
                widget.set_size_request(1, 1);
                layer.put(&widget, -10000, -10000);
            })
        }).map_err(|e| e.to_string())
    }

    pub fn place(view: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
        let (x, y, width, height) = (x.round() as i32, y.round() as i32, width.round().max(1.) as i32, height.round().max(1.) as i32);
        view.with_webview(move |platform| {
            let widget: gtk::Widget = platform.inner().upcast();
            LAYER.with(|l| {
                if let Some(layer) = l.borrow().as_ref() {
                    if widget.parent().as_ref() == Some(layer.upcast_ref()) { layer.move_(&widget, x, y); }
                }
            });
            widget.set_size_request(width, height);
            // Views now overlap the desktop instead of sitting beside it: keep this one's window on top.
            if let Some(window) = widget.window() { window.raise(); }
        }).map_err(|e| e.to_string())
    }
}
