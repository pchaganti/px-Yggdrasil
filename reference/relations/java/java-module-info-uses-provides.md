---
id: java-module-info-uses-provides
language: java
category: usage-site
expectation: edge
cites: "JLS SE25 §7.7 module declarations / directives; research E1 (NEW vs 06-14)"
---

## Rule

A `module-info.java` declaration carries TYPE references in two directives:
`uses TypeName;` names a service interface, and `provides TypeName with TypeName…;`
names the service interface plus one or more provider implementations. These are genuine
fully-qualified, SHADOW-FREE type FQNs (no §6.5.5 ambiguity) that resolve exactly like a
single-type import → real cross-node edges. The extractor emits the `uses` operand and
every `provides … with …` operand as TYPE path hints. The `requires` (module name),
`exports` and `opens` (package names) directives are EXCLUDED — they reference
modules/packages, never types; reading them as type references would be a phantom.

Separately, the provider implementation's own `implements com.acme.spi.Intf` clause is an
INLINE fully-qualified TYPE reference (a `scoped_type_identifier`), also shadow-free, so it
too edges — `Impl.java` depends on node `spi` independently of the `module-info.java`
directives.

## Files

```java path=src/main/java/com/acme/spi/Intf.java
package com.acme.spi;
public interface Intf {}
```

```java path=src/main/java/com/acme/impl/Impl.java
package com.acme.impl;
public class Impl implements com.acme.spi.Intf {}
```

```java path=src/main/java/com/acme/req/ReqType.java
package com.acme.req;
public class ReqType {}
```

```java path=src/main/java/com/acme/exp/ExpType.java
package com.acme.exp;
public class ExpType {}
```

```java path=src/main/java/com/acme/opn/OpnType.java
package com.acme.opn;
public class OpnType {}
```

```java path=src/main/java/module-info.java
module com.example.foo {
  requires com.acme.req.ReqType;
  exports com.acme.exp.ExpType;
  opens com.acme.opn.OpnType;
  uses com.acme.spi.Intf;
  provides com.acme.spi.Intf with com.acme.impl.Impl;
}
```

## Expect

- src/main/java/module-info.java:5 -> node:spi       # `uses com.acme.spi.Intf` → service type (node spi)
- src/main/java/module-info.java:6 -> node:spi       # `provides com.acme.spi.Intf` → service type (node spi)
- src/main/java/module-info.java:6 -> node:impl      # `provides … with com.acme.impl.Impl` → provider type (node impl)
- src/main/java/com/acme/impl/Impl.java:2 -> node:spi # provider `implements com.acme.spi.Intf` inline FQN → real edge (node spi)

## Why

`uses`/`provides` operands are real shadow-free service-type dependencies; the
`requires`/`exports`/`opens` operands are module/package names and must never edge —
even though ReqType/ExpType/OpnType are in-graph at the paths those operands would
resolve to if mis-read as types. The provider's `implements com.acme.spi.Intf` is an
inline fully-qualified TYPE reference, equally shadow-free, so it edges too.
