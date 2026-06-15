---
id: php-enum-case-relative-silence
language: php
category: usage-site
expectation: silence
cites: "php.net language.enumerations (enum case is a member; 8.1); research 2026-06-15 PART E §E13"
---

## Rule

An enum-case access `Suit::Hearts` with no leading backslash is a member access on the
namespace-relative enum class `App\Suit` (Rule 6) — the case `Hearts` is a member, not a
separate type. The enum reference is the usage-site class `Suit`, silenced like any
relative static access; treating the case as a separate `Hearts` type would be a false
positive.

## Files

```php path=src/Enums/Suit.php
<?php
namespace App\Enums;
enum Suit { case Hearts; case Spades; }
```

```php path=src/Order/Handler.php
<?php
namespace App;
class Handler { function m() { return Suit::Hearts; } }
```

```json path=composer.json
{ "autoload": { "psr-4": { "App\\": "src/" } } }
```

## Expect

- silence      # relative `Suit::Hearts` is member access on a usage-site enum class → silent; the case is not a separate type

## Why

The enum case is a member of the relative enum class; the import-only model resolves no
relative usage site, so both the enum reference and the case stay silent.
