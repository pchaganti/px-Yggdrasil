---
id: php-psr4-two-roots-both-hit-ambiguous-silence
language: php
category: import
expectation: silence
cites: "PSR-4 (≥1 base dir; no first-match-wins; autoloaders MUST NOT throw); research 2026-06-15 PART C §C5"
---

## Rule

When the class file exists under 2+ roots of one prefix, the FQN genuinely maps to two
distinct files (two candidate owner nodes). PSR-4 does NOT define first-match-wins —
autoloaders resolve such a clash by registration order, arbitrary to a static tool. With
`App\` → `["src", "lib"]` and `App\Pay\G` present under BOTH, resolution is ambiguous →
silence, never first-wins. Picking one would be a false positive.

## Files

```php path=src/Pay/G.php
<?php
namespace App\Pay;
class G {}
```

```php path=lib/Pay/G.php
<?php
namespace App\Pay;
class G {}
```

```php path=src/Order/Handler.php
<?php
namespace App\Order;
use App\Pay\G;
class Handler {}
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": ["src/", "lib/"] } } }
```

## Expect

- silence      # `App\Pay\G` exists under BOTH roots → 2+ distinct hits → ambiguous → silence (never first-wins)

## Why

Two distinct hits mean two candidate owner nodes; PSR-4 resolves such a clash
arbitrarily at runtime, so a static tool must not guess a root — it collapses to silence.
