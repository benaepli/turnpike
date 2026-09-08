#![allow(dead_code)]
use std::{mem::size_of, sync::Arc};
#[derive(Clone, Copy, Debug)]
struct WithinPick { index: usize, mask: u8, stock: usize, authority: bool }
#[derive(Debug)]
struct FreshPreview { chosen: usize, contest: Option<(bool,bool)>, skipped: bool, displaced: Option<(usize,u32)> }
struct BaselineAttribution { arm: Arc<str>, arm_index: i32, config_index: i32, variant_bits: i32 }
struct Attribution { arm: Arc<str>, arm_index: i32, config_index: i32, variant_bits: i32, replay_child: bool }
fn main() {
 println!("WithinPick={} FreshPreview={} ChainRankingOption={} FirstChain={} ShadowIndex={} BaselineAttribution={} Attribution={}",size_of::<WithinPick>(), size_of::<FreshPreview>(),size_of::<Option<((u8,u64,u64),f64,usize,u8)>>(),size_of::<Option<u64>>(),size_of::<Option<usize>>(),size_of::<BaselineAttribution>(),size_of::<Attribution>());
}
