---
status: accepted
---

# ADR 与 Topic Spec 的职责分离

工程工作流把 ADR 与 Topic Spec 视为可组合、但不互相替代的决策记录：ADR 仅用于难以逆转、有真实取舍且未来读者可能不理解的架构或边界决策，记录为何选择；`SPEC.md` 记录当前持久行为、接口和验收，`IMPLEMENTATION.md` 记录实现覆盖，`HISTORY.md` 仅记录该 Spec 的局部演进、替换、兼容性与必要背景。这样让少量稳定的“为何”与持续演进的“当前合同”分别拥有唯一事实源，避免把 ADR 写成规格或把 History 写成决策档案。
