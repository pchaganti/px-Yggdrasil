---
id: php-inline-backslash-new-edge
language: php
category: usage-site
expectation: edge
cites: "php.net language.namespaces.rules Rule 1 (leading-backslash absolute); research 2026-06-15 PART A (inline absolute extension)"
---

## Rule

A leading-backslash inline reference `new \App\Metrics\Timer()` is ABSOLUTE: the `\`
marks it as resolved from the global namespace, independent of the file's `namespace`
and `use` aliases (Rule 1) — so it is shadow-free and maps to a file by the SAME PSR-4
rule as an import. In a class-autoload position (here `new`) the extractor emits the
FQN with one leading `\` stripped → `App\Metrics\Timer`.

## Files

```php path=src/Metrics/Timer.php
<?php
namespace App\Metrics;
class Timer {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { $o = new \App\Metrics\Timer(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- src/Order/Handler.php:3 -> node:Metrics      # leading-`\` `new \App\Metrics\Timer()` → `App\Metrics\Timer` → src/Metrics/Timer.php (node Metrics)

## Why

A leading-backslash FQN has exactly one meaning regardless of namespace or use table,
so resolving it is provably zero-FP — the same safe direction as an import operand.
