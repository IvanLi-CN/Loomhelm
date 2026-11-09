# Task Agent owns child PR delivery

Status: accepted

In multi-task flow, the Task Agent is the sole owner of a task's normal implementation and child PR lifecycle: it completes the atoms, verifies the acceptance criteria, records structured quality evidence, and merges its own child PR. The delivery coordinator owns parent branch and parent PR integration, while the main Agent owns global orchestration and exceptional decisions. A PR conflict or failed check is first classified by the Task Agent; self-caused problems stay with that task, while confirmed external problems are escalated to the main Agent for a user-decided orchestration change, normally through a separate repair contribution task. Base changes remain the Task Agent's responsibility. This removes the normal child-review gate because inserting another Agent before every child merge violates task independence and causes repeated multi-Agent handling of one task.
