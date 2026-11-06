# Contribution tasks and delivery units

Use **Contribution task** for repository changes delivered through a child PR, including code, documentation, tests, and configuration. Use **Verification**, **Release**, **Deployment**, and **Coordination** for work whose completion is established by its corresponding evidence rather than a child PR.

Call the virtual parent-branch and parent-PR integration boundary a **Delivery unit**. It is a ledger grouping and acceptance boundary, not a native conversation hierarchy or a second controller: the main Agent directly manages every task and delivery unit, while a Delivery coordinator acts only within delegated scope. A contribution child PR targets the current delivery-unit parent branch; the delivery-unit parent PR targets the repository target branch.

The canonical names remove the ambiguity of “development” and “other” while preserving unfinished ledgers: the validator may read those two legacy values, while new fixtures and plans use the canonical kinds. Internal `group` and `group_id` field names remain for ledger compatibility.
