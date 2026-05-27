Every mutation endpoint must call `auditLog.emit()` before returning.

The event must include: userId, action, timestamp, resourceId.
