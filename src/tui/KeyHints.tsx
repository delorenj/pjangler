// The footer every Ink screen ends with: `key label · key label ...`.

import { Box, Text } from "ink";
import { marks, themeColor } from "./theme";

export interface KeyHint {
  keys: string;
  label: string;
}

export function KeyHints({ hints }: { hints: readonly KeyHint[] }) {
  return (
    <Box flexWrap="wrap" columnGap={1}>
      {hints.map((hint, i) => (
        <Box key={hint.keys}>
          <Text color={themeColor("accent")}>{hint.keys}</Text>
          <Text color={themeColor("muted")}> {hint.label}{i < hints.length - 1 ? ` ${marks.dot}` : ""}</Text>
        </Box>
      ))}
    </Box>
  );
}
