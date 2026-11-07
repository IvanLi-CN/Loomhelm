# Native background preview handoff guard 演进历史（#a4ge9）

> 这里记录会影响 Agent 理解“为什么一步步变成现在这样”的关键演进；单次任务流水账不放这里，规范正文仍以 `./SPEC.md` 为准。

## Decision Trace

- `ae26703` fix(workflow): tighten native preview handoff guard
- `b39a914` docs(specs): adopt topic-level spec model
- Dashboard wrapper lease lifecycle and host-native session responsibility are now explicit in the topic contract.
- Heartbeat ownership now separates first PID binding from expected-owner validation, preserving compatibility while protecting replacement leases.
- Startup registration now claims the inspected lease state under the registry lock before updating PID/session metadata.
- The wrapper completes that claim before binding its HTTP listener, so a rejected claim never briefly occupies the preview port.
- The wrapper now holds the registry lock through listener binding, records PID only after confirmation, and rejects duplicate startup without replacing the active owner.
- Startup cleanup now captures the listener handle before post-bind verification or lease persistence, so failed claims stop the newly bound service.

## Legacy Change Log

- No legacy change-log section was recorded for this spec.

## References

- `./SPEC.md`
- `./IMPLEMENTATION.md`
- Legacy compatibility identity: `#a4ge9`.
