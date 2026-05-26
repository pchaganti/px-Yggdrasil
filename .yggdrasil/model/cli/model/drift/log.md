## [2026-05-26T08:33:12.484Z]
AspectVerificationResult.providerError boolean → required errorSource discriminator. Mirrors AspectResponse change in cli/llm/shared. Removes deprecated optional fields added as bridge in Tasks 1+2. ApproveResult.aspectViolations also updated to include errorSource so LlmApproveResult extends it without type incompatibility.
