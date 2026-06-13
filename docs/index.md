---
layout: home
title: Yggdrasil
hero:
  name: Yggdrasil
  text: Continuous verification for AI-generated code.
  image:
    src: /logo.svg
    alt: Yggdrasil
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Core Concepts
      link: /core-concepts
features:
  - title: Scoped rules, not flat files
    details: Aspects deliver only the 3-5 rules relevant to the file your agent is editing. No noise, no filtering.
  - title: Mechanical verification
    details: An LLM or deterministic reviewer checks source code against aspect rules. Every verdict is recorded in a committed lock; if it doesn't pass, the agent fixes it.
  - title: Cached, content-addressed verdicts
    details: Change a rule or its code and exactly the affected (aspect, unit) pairs need re-verification — everything else keeps its recorded verdict. CI just recomputes hashes.
  - title: Draft, advisory, enforced
    details: Stage every rule through three statuses — author silently, observe as warnings, then block CI. No flag-day rollouts.
---
