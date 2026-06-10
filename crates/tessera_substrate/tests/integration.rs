//! End-to-end integration tests for the knowledge substrate adapter.
//!
//! These exercise the exact `SubstrateManager` surface the
//! `tessera_bridge` N-API layer delegates to: opening alongside a
//! Tessera-style main DB without conflict, extracting observations from
//! indexed text, building the concept graph, the pin/unpin/forget
//! lifecycle, decay, and synthesis.

use std::fs;

use tessera_substrate::{
    substrate_sibling_entries, SubstrateManager, SUBSTRATE_CONCEPTS_ARCNAME,
    SUBSTRATE_EVIDENCE_ARCNAME,
};

/// A 64-char hex SQLCipher key, matching what Tessera passes to
/// `init_bridge`.
const TEST_KEY_HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Realistic chunk text that exercises every observation type: entity
/// mentions, a task (`TODO`), a decision (`decided`), and a question.
fn sample_chunks() -> Vec<String> {
    vec![
        "@Sara please loop in Acme on the Migration project.".to_string(),
        "TODO: draft the launch RFC by Friday.".to_string(),
        "We decided to ship the launch on Friday.".to_string(),
        "When should we deploy the new connector?".to_string(),
    ]
}

#[test]
fn opens_alongside_main_db_without_conflict() {
    let dir = tempfile::tempdir().expect("tempdir");
    let main_db = dir.path().join("tessera.db");
    // Simulate Tessera's existing main DB file already on disk.
    fs::write(&main_db, b"preexisting tessera db bytes").expect("write main db");

    let manager = SubstrateManager::open(main_db.to_str().unwrap(), Some(TEST_KEY_HEX))
        .expect("substrate opens next to the main DB");
    drop(manager);

    // The substrate must create its OWN sibling files, never touch the
    // main DB, and leave the original bytes intact.
    assert_eq!(
        fs::read(&main_db).expect("main db still readable"),
        b"preexisting tessera db bytes",
        "substrate must not overwrite the main DB"
    );
    assert!(
        dir.path().join("tessera.db.substrate-evidence.db").exists(),
        "evidence sibling file should be created"
    );
    assert!(
        dir.path().join("tessera.db.substrate-concepts.db").exists(),
        "concepts sibling file should be created"
    );
}

#[test]
fn extracts_observations_and_memories_from_chunks() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_id = "22222222-2222-4222-8222-222222222222";

    let count = manager
        .extract_observations(source_id, &sample_chunks())
        .expect("extract");
    assert!(count > 0, "expected observations from realistic text");

    let memories = manager.list_memories(None).expect("list");
    assert_eq!(
        memories.len() as u32,
        count,
        "every observation should mint exactly one memory object"
    );

    let types: std::collections::HashSet<&str> = memories
        .iter()
        .map(|m| m.observation_type.as_str())
        .collect();
    assert!(types.contains("entity"), "entities should be extracted");
    assert!(types.contains("task"), "a TODO should yield a task");
    assert!(types.contains("decision"), "a decision should be extracted");
    assert!(types.contains("question"), "a question should be extracted");

    // Every memory must be attributed to the originating source.
    assert!(memories
        .iter()
        .all(|m| m.source_id.as_deref() == Some(source_id)));
}

#[test]
fn reextraction_is_idempotent_per_source() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_id = "33333333-3333-4333-8333-333333333333";

    let first = manager
        .extract_observations(source_id, &sample_chunks())
        .expect("first extract");
    let after_first = manager.list_memories(None).expect("list").len();

    let second = manager
        .extract_observations(source_id, &sample_chunks())
        .expect("second extract");
    let after_second = manager.list_memories(None).expect("list").len();

    assert_eq!(first, second, "same input must extract the same count");
    assert_eq!(
        after_first, after_second,
        "re-extracting one source must replace, not duplicate, its memories"
    );
}

#[test]
fn two_sources_accumulate_independently() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_a = "44444444-4444-4444-8444-444444444444";
    let source_b = "55555555-5555-4555-8555-555555555555";

    manager
        .extract_observations(source_a, &sample_chunks())
        .unwrap();
    let after_a = manager.list_memories(None).expect("list").len();
    manager
        .extract_observations(source_b, &sample_chunks())
        .unwrap();
    let after_b = manager.list_memories(None).expect("list").len();

    assert!(
        after_b > after_a,
        "a second source must add memories alongside the first"
    );
}

#[test]
fn concept_graph_builds_from_entities() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_id = "66666666-6666-4666-8666-666666666666";
    manager
        .extract_observations(source_id, &sample_chunks())
        .unwrap();

    let json = manager
        .concept_graph_json(None, Some(100))
        .expect("graph json");
    let view: serde_json::Value = serde_json::from_str(&json).expect("valid graph json");

    let nodes = view
        .get("nodes")
        .and_then(|n| n.as_array())
        .expect("graph view has a nodes array");
    assert!(
        nodes.len() >= 2,
        "expected entity nodes plus a source node, got {}",
        nodes.len()
    );

    let labels: Vec<&str> = nodes
        .iter()
        .filter_map(|n| n.get("label").and_then(serde_json::Value::as_str))
        .collect();
    assert!(
        labels.iter().any(|l| l.starts_with("source:")),
        "a per-source node should anchor the document's concepts"
    );
}

#[test]
fn pin_unpin_forget_lifecycle() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_id = "77777777-7777-4777-8777-777777777777";
    manager
        .extract_observations(source_id, &sample_chunks())
        .unwrap();

    let target = manager.list_memories(None).expect("list")[0].id.clone();

    let pinned = manager.pin_memory(&target).expect("pin");
    assert_eq!(pinned.pin_count, 1);
    assert!(pinned.retention_score >= 0.9, "pin floors retention at 0.9");
    assert_ne!(pinned.state, "candidate", "pin promotes a candidate");

    let unpinned = manager.unpin_memory(&target).expect("unpin");
    assert_eq!(unpinned.pin_count, 0);

    manager.forget_memory(&target).expect("forget");
    assert!(
        manager
            .list_memories(None)
            .expect("list")
            .iter()
            .all(|m| m.id != target),
        "a forgotten memory must be gone"
    );

    // Forgetting a non-existent / unknown id is a clean error.
    assert!(manager.forget_memory(&target).is_err());
    assert!(manager.pin_memory("not-a-uuid").is_err());
}

#[test]
fn remove_source_purges_only_that_sources_memories() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_a = "a1111111-1111-4111-8111-111111111111";
    let source_b = "b2222222-2222-4222-8222-222222222222";

    manager
        .extract_observations(source_a, &sample_chunks())
        .unwrap();
    let after_a = manager.list_memories(None).expect("list").len();
    manager
        .extract_observations(source_b, &sample_chunks())
        .unwrap();
    let only_b = manager.list_memories(None).expect("list").len() - after_a;
    assert!(only_b > 0, "source B must contribute memories");

    // Removing source A drops exactly A's memories, leaving B's intact.
    manager.remove_source(source_a).expect("remove source a");
    let remaining = manager.list_memories(None).expect("list");
    assert_eq!(
        remaining.len(),
        only_b,
        "only source B's memories should remain after removing A"
    );
    assert!(
        remaining
            .iter()
            .all(|m| m.source_id.as_deref() == Some(source_b)),
        "no memory attributed to the removed source may survive"
    );
}

#[test]
fn remove_source_is_idempotent_and_safe_for_unknown_source() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_id = "c3333333-3333-4333-8333-333333333333";
    manager
        .extract_observations(source_id, &sample_chunks())
        .unwrap();

    manager.remove_source(source_id).expect("first remove");
    assert!(
        manager.list_memories(None).expect("list").is_empty(),
        "the only source's memories must all be gone"
    );

    // A second remove (now a no-op) and removing a source that never
    // had any substrate data must both succeed cleanly.
    manager.remove_source(source_id).expect("idempotent remove");
    manager
        .remove_source("d4444444-4444-4444-8444-444444444444")
        .expect("removing an unknown source is a clean no-op");
}

#[test]
fn removed_source_artifacts_stay_gone_across_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let main_db = dir.path().join("tessera.db");
    let source_id = "e5555555-5555-4555-8555-555555555555";

    {
        let mut manager =
            SubstrateManager::open(main_db.to_str().unwrap(), Some(TEST_KEY_HEX)).expect("open");
        manager
            .extract_observations(source_id, &sample_chunks())
            .unwrap();
        manager.remove_source(source_id).expect("remove");
    }

    // Reopen with the same key: the purge must be durable, not just an
    // in-memory drop.
    let manager =
        SubstrateManager::open(main_db.to_str().unwrap(), Some(TEST_KEY_HEX)).expect("reopen");
    assert!(
        manager.list_memories(None).expect("list").is_empty(),
        "a removed source's memories must not resurrect after reopen"
    );
}

#[test]
fn fresh_memories_survive_a_decay_sweep() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_id = "88888888-8888-4888-8888-888888888888";
    let count = manager
        .extract_observations(source_id, &sample_chunks())
        .unwrap();

    let report = manager.run_decay_sweep().expect("decay sweep");
    assert_eq!(report.scored, count, "every memory is rescored");
    assert_eq!(
        report.candidates_archived, 0,
        "freshly-extracted memories must not be archived immediately"
    );
}

#[test]
fn synthesis_groups_observations_by_type() {
    let mut manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");
    let source_id = "99999999-9999-4999-8999-999999999999";
    manager
        .extract_observations(source_id, &sample_chunks())
        .unwrap();

    let summary = manager.trigger_synthesis(None).expect("synthesis");
    assert!(!summary.window_id.is_empty());
    assert!(!summary.recap.is_empty());
    assert!(
        !summary.decisions.is_empty(),
        "the 'decided to ship' sentence should land in decisions"
    );
    assert!(
        !summary.active_tasks.is_empty(),
        "the TODO should land in active tasks"
    );
    assert!(
        !summary.open_questions.is_empty(),
        "the question should land in open questions"
    );
}

#[test]
fn data_persists_across_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let main_db = dir.path().join("tessera.db");
    let source_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    let count = {
        let mut manager =
            SubstrateManager::open(main_db.to_str().unwrap(), Some(TEST_KEY_HEX)).expect("open");
        manager
            .extract_observations(source_id, &sample_chunks())
            .unwrap()
    };

    // Reopen with the same key: persisted memories must rehydrate.
    let manager =
        SubstrateManager::open(main_db.to_str().unwrap(), Some(TEST_KEY_HEX)).expect("reopen");
    let memories = manager.list_memories(None).expect("list");
    assert_eq!(
        memories.len() as u32,
        count,
        "memories must survive a reopen"
    );
}

#[test]
fn snapshot_into_produces_reopenable_consistent_copies() {
    let dir = tempfile::tempdir().expect("tempdir");
    let main_db = dir.path().join("tessera.db");
    let source_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    let mut manager =
        SubstrateManager::open(main_db.to_str().unwrap(), Some(TEST_KEY_HEX)).expect("open");
    let count = manager
        .extract_observations(source_id, &sample_chunks())
        .expect("extract");
    assert!(count > 0, "fixture should extract at least one observation");

    // Snapshot the live (still-open) substrate into a staging dir.
    let snap_dir = dir.path().join("snap");
    let entries = manager.snapshot_into(&snap_dir).expect("snapshot");
    assert_eq!(entries.len(), 2, "one entry per sibling DB");

    let evidence_snap = snap_dir.join(SUBSTRATE_EVIDENCE_ARCNAME);
    let concepts_snap = snap_dir.join(SUBSTRATE_CONCEPTS_ARCNAME);
    assert!(evidence_snap.exists(), "evidence snapshot written");
    assert!(concepts_snap.exists(), "concepts snapshot written");
    // Snapshots are standalone (no -wal / -journal sidecars).
    assert!(!snap_dir
        .join(format!("{SUBSTRATE_EVIDENCE_ARCNAME}-wal"))
        .exists());
    assert!(!snap_dir
        .join(format!("{SUBSTRATE_EVIDENCE_ARCNAME}-journal"))
        .exists());
    // Entry paths point at the produced files with the stable arcnames.
    for entry in &entries {
        assert!(
            entry.path.exists(),
            "entry path {} exists",
            entry.path.display()
        );
        assert_eq!(
            entry.path.file_name().unwrap().to_str().unwrap(),
            entry.arcname
        );
    }

    drop(manager);

    // Restore the snapshots into a *fresh* main DB's sibling locations
    // (the same swap a real restore performs), then reopen under the
    // same key — the snapshot must re-key transparently and carry every
    // memory across.
    let restored_main = dir.path().join("restored.db");
    let targets = substrate_sibling_entries(restored_main.to_str().unwrap());
    assert_eq!(targets.len(), 2);
    for target in &targets {
        let src = if target.arcname == SUBSTRATE_EVIDENCE_ARCNAME {
            &evidence_snap
        } else {
            &concepts_snap
        };
        if let Some(parent) = target.path.parent() {
            fs::create_dir_all(parent).expect("mkdir restore parent");
        }
        fs::copy(src, &target.path).expect("swap snapshot into place");
    }

    let restored = SubstrateManager::open(restored_main.to_str().unwrap(), Some(TEST_KEY_HEX))
        .expect("reopen restored");
    let memories = restored.list_memories(None).expect("list restored");
    assert_eq!(
        memories.len() as u32,
        count,
        "restored snapshot must carry every memory"
    );
}

#[test]
fn snapshot_into_overwrites_stale_snapshot_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manager = SubstrateManager::open(":memory:", Some(TEST_KEY_HEX)).expect("open");

    let snap_dir = dir.path().join("snap");
    fs::create_dir_all(&snap_dir).expect("mkdir");
    // Pre-seed stale files at the snapshot target names; snapshot_into
    // must clear them rather than fail on VACUUM INTO's present-dest guard.
    fs::write(snap_dir.join(SUBSTRATE_EVIDENCE_ARCNAME), b"stale").expect("seed");
    fs::write(snap_dir.join(SUBSTRATE_CONCEPTS_ARCNAME), b"stale").expect("seed");

    let entries = manager
        .snapshot_into(&snap_dir)
        .expect("snapshot over stale");
    assert_eq!(entries.len(), 2);
    // The produced snapshots are real SQLCipher DBs, not the 5-byte stub.
    for entry in &entries {
        let len = fs::metadata(&entry.path).expect("stat").len();
        assert!(
            len > 5,
            "snapshot {} should be a real DB, got {len} bytes",
            entry.arcname
        );
    }
}

#[test]
fn sibling_entries_empty_for_in_memory() {
    assert!(
        substrate_sibling_entries(":memory:").is_empty(),
        "in-memory path has no on-disk siblings to back up"
    );
}
