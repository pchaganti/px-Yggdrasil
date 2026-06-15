---
id: csharp-di-reflection-extension-silence
language: csharp
category: dynamic
expectation: silence
cites: "C# — runtime DI/reflection/extension-method dispatch (no static type reference); MS Learn — dependency injection, Type.GetType"
---

## Rule

Dependency-injection registration (`services.AddScoped<IFoo, Foo>()` resolved at
runtime), a reflection string (`Type.GetType("MyApp.Pay.Gateway")`), and an
extension-method call on a runtime value (`order.Validate()`) are not statically
resolvable type references. A type named ONLY inside a reflection string is not a
real static dependency, so no cross-node edge may be emitted — even when that type
exists in the graph.

## Files

```csharp path=src/c/Use.cs
using Microsoft.Extensions.DependencyInjection;
class Startup {
  void Configure(IServiceCollection services) { services.AddScoped<IFoo, Foo>(); }
  void R() { var t = System.Type.GetType("MyApp.Pay.Gateway"); }
  void E(object order) { order.Validate(); }
}
```

```csharp path=src/pay/Gateway.cs
namespace MyApp.Pay;
public class Gateway {}
```

## Expect

- silence      # `MyApp.Pay.Gateway` appears only as a reflection STRING → not a static dependency → no edge

## Why

Reflection strings, runtime DI resolution, and extension dispatch are dynamic;
treating them as static references would invent dependencies that the compiler
never sees. Silence preserves zero false positives.
