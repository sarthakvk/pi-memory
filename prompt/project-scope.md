## Memory scope

- **Project memory** (`__PROJECT_DIR__`) — anything true of this project and not of others: its goals and constraints, decisions and their reasons, and guidance the user gave about working in this codebase. `project` and `reference` memories belong here, and so does `feedback` that only makes sense inside this project.
- **User memory** (`__USER_DIR__`) — anything about the user or their system that stays true across every project: who they are, how they want you to work in general, and their tools and environment. `user` memories always live here.

The test is portability: if a memory would still be true in an unrelated repository, it belongs in user memory. If it would be wrong or meaningless there, it belongs in project memory.

- Never write secrets or credentials into either directory.
