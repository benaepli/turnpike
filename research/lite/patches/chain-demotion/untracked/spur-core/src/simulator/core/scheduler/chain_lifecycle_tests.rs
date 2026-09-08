mod chain_lifecycle_tests {
    use super::*;
    use crate::analysis::resolver::NameId;
    use crate::compiler::cfg::{Cfg, Lhs, VarSlot};
    use crate::simulator::core::state::{ChannelState, Timer};
    use crate::simulator::core::values::ChannelId;
    use crate::simulator::path::Logs;
    use std::collections::HashMap;

    struct ForcedQueue(QueueSelection);

    impl QueueSelector for ForcedQueue {
        fn select(&mut self, _: &QueueInfo, _: &mut impl Rng) -> Option<QueueSelection> {
            Some(self.0)
        }
    }

    fn program_without_execution() -> Program {
        Program {
            cfg: Cfg { graph: vec![] },
            rpc: HashMap::new(),
            func_name_to_id: HashMap::new(),
            id_to_name: HashMap::new(),
            next_name_id: 0,
            vertex_to_span: HashMap::new(),
            max_node_slots: 1,
            roles: vec![],
            type_ids: HashMap::new(),
        }
    }

    fn dispatch(
        state: &mut State<NoHashing>,
        program: &Program,
        queue: QueueSelection,
    ) -> ScheduleResult<NoHashing> {
        let servers = state.nodes.len() as i32;
        schedule_runnable::<NoHashing, _, _, NoFeedback>(
            state,
            &mut Logs::default(),
            program,
            &(),
            &mut (),
            &TopologyInfo {
                topology: Topology::Full,
                num_servers: servers,
            },
            &GlobalState::new(),
            &SchedulePolicy::Fixed,
            false,
            &mut ForcedQueue(queue),
            &WithinQueueSelector::Tournament { k: 2 },
            &ResolvedTerms::default(),
            &PurgatoryConfig::default(),
            0.0,
            timer_context::RunMode::Probe,
            &[],
            &mut StdRng::seed_from_u64(37),
        )
        .expect("the forced dispatch succeeds")
    }

    fn waiting_reader(state: &mut State<NoHashing>) -> (ChannelId, u64) {
        let index = queue_record(state, 0, 1, 0, 0.5);
        let Runnable::Record(mut reader) = state.take_network(index) else {
            unreachable!();
        };
        reader.pc = 17;
        let chain = reader.chain_id;
        let channel = ChannelId {
            node: node(1),
            id: state.alloc_channel_id(),
        };
        let mut chan = ChannelState::new();
        chan.push_waiting_reader(reader, Lhs::Var(VarSlot::Local(0, NameId(0))));
        state.channels.insert(channel, chan);
        (channel, chain)
    }

    #[test]
    fn timer_wakeup_starts_a_fresh_chain() {
        let _serial = crate::simulator::config_override::exclusive_session();
        let mut state = State::new(&[(ROLE, 2)], 1);
        let (channel, waiting_chain) = waiting_reader(&mut state);
        state.push_runnable(Runnable::Timer(Timer {
            pc: 0,
            node: node(1),
            channel,
            priority: 0.25,
            label: Some("wake".into()),
        }));
        let result = dispatch(
            &mut state,
            &program_without_execution(),
            QueueSelection::Timer,
        );
        assert!(matches!(result, ScheduleResult::TimerFired { .. }));
        let Runnable::Record(reader) = &state.local_queues[1][0] else {
            panic!("the timer wakes the blocked reader");
        };
        assert_ne!(reader.chain_id, 0);
        assert_ne!(reader.chain_id, waiting_chain);
        assert_eq!(reader.pc, 17);
        assert_eq!(reader.timer_entry, Some(17));
    }

    #[test]
    fn remote_channel_wakeup_preserves_the_waiting_chain() {
        let _serial = crate::simulator::config_override::exclusive_session();
        let mut state = State::new(&[(ROLE, 2)], 1);
        let (channel, waiting_chain) = waiting_reader(&mut state);
        let sending_chain = state.chains.root();
        state.push_runnable(Runnable::ChannelSend {
            chain_id: sending_chain,
            target: node(1),
            channel,
            message: Value::int(42),
            origin_node: node(0),
            pc: 0,
            priority: 0.5,
        });
        dispatch(
            &mut state,
            &program_without_execution(),
            QueueSelection::Network,
        );
        let Runnable::Record(reader) = &state.local_queues[1][0] else {
            panic!("the channel send wakes the blocked reader");
        };
        assert_eq!(reader.chain_id, waiting_chain);
        assert_ne!(reader.chain_id, sending_chain);
        assert_eq!(reader.pc, 17);
        assert_eq!(reader.timer_entry, None);
    }

    #[test]
    fn crash_and_recovery_keep_message_identity_and_root_recovery_work() {
        let _serial = crate::simulator::config_override::exclusive_session();
        let program = crate::compiler::compile(
            "role Node { async fn RecoverInit(me: int, peers: list<Node>) { <-set_timer(\"recover\"); } }",
            "chain_recovery.spur",
        ).into_program().expect("the recovery fixture compiles");
        let role = program
            .roles
            .iter()
            .find(|(_, name)| name == "Node")
            .unwrap()
            .0;
        let mut state = State::new(&[(role, 2)], program.max_node_slots as usize);
        let index = queue_record(&mut state, 0, 1, 0, 0.5);
        let Runnable::Record(record) = &mut state.network_queue[index] else {
            unreachable!()
        };
        record.node.role = role;
        record.origin_node.role = role;
        record.pc = 9;
        let chain = record.chain_id;
        let victim = NodeId { role, index: 1 };
        state.push_runnable(Runnable::Crash {
            node_id: victim,
            priority: 1.0,
        });
        assert!(matches!(
            dispatch(&mut state, &program, QueueSelection::Local(1)),
            ScheduleResult::Crash { .. }
        ));
        assert_eq!(state.crash_info.queued_messages.len(), 1);
        let (_, buffered) = &state.crash_info.queued_messages[0];
        assert_eq!(buffered.chain_id, chain);
        assert_eq!(buffered.pc, buffered.entry_pc);
        state.push_runnable(Runnable::Recover {
            node_id: victim,
            priority: 1.0,
        });
        assert!(matches!(
            dispatch(&mut state, &program, QueueSelection::Local(1)),
            ScheduleResult::Recover { .. }
        ));
        assert!(state.crash_info.queued_messages.is_empty());
        let Runnable::Record(released) = &state.network_queue[0] else {
            unreachable!()
        };
        assert_eq!(released.chain_id, chain);
        assert!(released.bias.contains(DeliveryBias::RECEIVER_RESTARTED));
        let readers: Vec<_> = state
            .channels
            .values()
            .flat_map(|c| c.waiting_readers.iter())
            .collect();
        assert_eq!(readers.len(), 1);
        assert_ne!(readers[0].0.chain_id, 0);
        assert_ne!(readers[0].0.chain_id, chain);
        let recovery_chain = readers[0].0.chain_id;
        state.chains.configure(1, 3, true, false, 0);
        state.chains.before_step(0, true, true);
        state.chains.before_step(1, true, true);
        assert!(state.chains.key(recovery_chain) < state.chains.key(chain));
    }
    #[test]
    fn chain_ranking_preserves_queue_class_draws_and_empty_fallbacks() {
        let _serial = crate::simulator::config_override::exclusive_session();
        util_stats::set_enabled(false);
        #[derive(Clone)]
        struct Capture {
            inner: crate::simulator::core::queue_selector::ProbabilisticSelector,
            selected: Option<QueueSelection>,
        }
        impl QueueSelector for Capture {
            fn select(&mut self, info: &QueueInfo, rng: &mut impl Rng) -> Option<QueueSelection> {
                self.selected = self.inner.select(info, rng);
                self.selected
            }
            fn supports_timer_bias(&self) -> bool {
                true
            }
            fn select_timer_biased(
                &mut self,
                info: &QueueInfo,
                bias: f64,
                rng: &mut impl Rng,
            ) -> Option<QueueSelection> {
                self.selected = self.inner.select_timer_biased(info, bias, rng);
                self.selected
            }
        }
        let program = program_without_execution();
        for queues in 1..8 {
            let mut initial = State::new(&[(ROLE, 2)], 1);
            if queues & 1 != 0 {
                initial.push_runnable(Runnable::Crash {
                    node_id: node(0),
                    priority: 0.5,
                });
            }
            if queues & 2 != 0 {
                queue_channel_send(&mut initial, 0, 1);
                queue_channel_send(&mut initial, 0, 1);
            }
            if queues & 4 != 0 {
                initial.push_runnable(Runnable::Timer(Timer {
                    pc: 0,
                    node: node(1),
                    channel: ChannelId {
                        node: node(1),
                        id: 0,
                    },
                    priority: 0.5,
                    label: Some("wake".into()),
                }));
            }
            for seed in 0..32 {
                let mut a = initial.clone();
                let mut b = initial.clone();
                b.chains.active = true;
                let mut ra = StdRng::seed_from_u64(seed);
                let mut rb = ra.clone();
                let mut qa = Capture {
                    inner: crate::simulator::core::queue_selector::ProbabilisticSelector {
                        p_local: 0.3,
                        p_timer: 0.3,
                    },
                    selected: None,
                };
                let mut qb = qa.clone();
                for (state, rng, selector) in
                    [(&mut a, &mut ra, &mut qa), (&mut b, &mut rb, &mut qb)]
                {
                    schedule_runnable::<NoHashing, _, _, NoFeedback>(
                        state,
                        &mut Logs::default(),
                        &program,
                        &(),
                        &mut (),
                        &TopologyInfo {
                            topology: Topology::Full,
                            num_servers: 2,
                        },
                        &GlobalState::new(),
                        &SchedulePolicy::Fixed,
                        false,
                        selector,
                        &WithinQueueSelector::Tournament { k: 10 },
                        &ResolvedTerms::default(),
                        &PurgatoryConfig::default(),
                        0.0,
                        timer_context::RunMode::Steered,
                        &[],
                        rng,
                    )
                    .unwrap();
                }
                assert_eq!(format!("{:?}", qa.selected), format!("{:?}", qb.selected));
                assert_eq!(ra.next_u64(), rb.next_u64());
            }
        }
    }
}
