# Tools

## render-demo-gif.js

Renders `docs/public/demo.gif` from a scripted terminal simulation using node-canvas.

The scene (init, agent building graph, approve failing, fix, approve passing) is defined inline in the script. Edit the script to change what the GIF shows.

### Dependencies

```bash
npm install canvas gifencoder
```

### Usage

```bash
node tools/render-demo-gif.js
```

Writes to `docs/public/demo.gif`. The HTML version at `docs/public/demo.html` shows the same scene with animations and is the source of truth for the script.
