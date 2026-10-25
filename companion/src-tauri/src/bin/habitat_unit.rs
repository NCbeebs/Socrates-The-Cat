//! Optional native unit-check runner when `cargo test` binaries fail to load on Windows.
//! Invokes the same assertion functions as `#[test]` in `companion_lib`.
//!
//! `cargo run --locked --features habitat-unit-tests --bin habitat_unit`
fn main() {
    companion_lib::run_habitat_unit_tests();
    println!("habitat_unit: ok (31 checks)");
}
