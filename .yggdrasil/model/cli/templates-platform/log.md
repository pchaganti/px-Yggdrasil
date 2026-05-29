## [2026-05-29T22:37:52.435Z]
The init-time templates were separated so the agent-rules content stands alone from the configuration and platform-installer templates, keeping each unit small enough that a reviewer can inspect it in full without context-window truncation. No template content changed; only which node owns which file.
