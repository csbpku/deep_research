import { describe, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { prepareRadarReadingContent } from './radar-reading-blocks';
import MarkdownContent from '@/components/MarkdownContent';

describe('ipython detail page render', () => {
  it('prepares and renders full content as RadarOriginalArticle does', () => {
    const rawContent = `# IPython is All You Need

August 10, 2026
[ipython](#)[terminal](#)[ai](#)

"I use IPython as my terminal's shell."

"IPython in the shell?"

"No, IPython is the shell."

"IPython? As the shell?"

"Only way to live."

"What about cat, ls, cd? What about vim for God's sake, man?!"

"I use those... But in IPython."

"Oh you are one of those \`!\` people..."

"No, I almost never need \`!\`."

"That's ridiculous. You're asking me to believe in \`!\`less IPython bash commands?"

"I'm not asking you, I'm telling you."

"You're telling me you use IPython to run bash?"

"No, it's all IPython and nothing but IPython. I can even draw matplotlib plots in the terminal."

"My god... Wait, did you say draw? Like ASCII art?"

"No, I mean images."

"Images?... In the terminal?..."

"Yes, images... In the terminal..."

"Omg, this is too much... What do you even do with an IPython shell?"

"Data exploration, setting up my NAS, asking questions to an AI that lives in my shell, the usual."

"That doesn't sound usual at all. So it's an intelligent shell? That's what you're telling me?"

"Yes, it can see the code I've written and even the images."

"It sees the images in the terminal? It's not just a you thing?"

"I'm not hallucinating the images..."

"An intelligent IPython shell?"

"Yes, exactly! It has a tool to execute python co..."

"But can it..."

"Yes... it can run bash commands."

"Even withou..."

"Yes, even without the \`!\`..."

"Aren't you um... a bit scared of it? What if it decided to, you know... delete your home directory?"

"I've thought about it. It's why I use IPython's restricted execution mode..."

"That sounds... responsible."

"I try."`;

    const title = 'IPython is All You Need';
    const paperMode = false;
    const prepared = prepareRadarReadingContent(rawContent, title, paperMode);
    console.log('=== PREPARED (first 500 chars) ===');
    console.log(prepared.slice(0, 500));
    console.log('--- starts with h1?', prepared.startsWith('#'));

    // Mirror RadarOriginalArticle: pass prepared content as a single MarkdownContent
    const html = renderToString(
      React.createElement(MarkdownContent, { content: prepared })
    );
    console.log('=== HTML (first 3000 chars) ===');
    console.log(html.slice(0, 3000));
  });
});
