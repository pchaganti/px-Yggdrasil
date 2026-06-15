---
id: php-new-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.namespaces.rules Rule 6 (E1 new); research 2026-06-15 PART E §E1"
---

## Rule

`new Foo()` with no leading backslash is a namespace-RELATIVE class reference: in
`namespace App` it resolves to `App\Foo` by current-namespace prepend (Rule 6, no
global fallback). Binding it would require reconstructing the file's namespace + `use`
aliases, which a source-only import-only tool does not do — so it is a deliberate
tolerated recall miss (silence), never a guess at the global `\Metrics\Timer`.

## Files

```php path=src/Metrics/Timer.php
<?php
namespace App\Metrics;
class Timer {}
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { $o = new Timer(); } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # `new Timer()` is namespace-relative (→ `App\Timer`), never the global `App\Metrics\Timer` → silent recall miss

## Why

A relative inline name needs the namespace + use table to bind; the import-only model
declines to resolve it rather than risk binding the wrong target.
