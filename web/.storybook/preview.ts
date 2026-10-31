import { RouterContextProvider } from "@tanstack/react-router";
import type { Preview } from "@storybook/react-vite";
import { createElement } from "react";

import { router } from "@/app/router";
import "../src/index.css";

const preview: Preview = {
  decorators: [
    (Story) => createElement(RouterContextProvider, { router }, createElement(Story))
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    layout: "fullscreen"
  }
};

export default preview;
