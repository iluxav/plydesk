/// The flake was in GetUpdates: a quiet interval longer than the 500ms poll
/// looked like a dropped connection. Repeat it enough to be convincing.
#[test]
#[ignore]
fn get_updates_survives_quiet_intervals() {
    let target = std::env::var("PLYDESK_HOST").expect("set PLYDESK_HOST");
    let mut h = plydesk_core::Host::connect(&target).expect("connect");
    for i in 1..=12 {
        match plydesk_core::packagekit::list_updates(&mut h) {
            Ok(u) => println!("  {i:>2}. {} updates", u.len()),
            Err(e) => panic!("run {i} failed: {e}"),
        }
    }
    h.disconnect();
}
