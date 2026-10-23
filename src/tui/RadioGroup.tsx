// A controlled radio group. Arrow keys move (left/right when horizontal, up/down when
// vertical), digits 1..n jump, and every move calls onChange immediately; confirming
// (Enter) is the screen's business, not the group's, so the same widget serves both a
// "pick then confirm" prompt and an "apply as you go" dashboard.

import { Box, Text, useInput } from "ink";
import { marks, themeColor } from "./theme";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  /** Small dim note after the label, e.g. "global". */
  badge?: string;
}

export interface RadioGroupProps<T extends string> {
  options: readonly RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
  orientation?: "horizontal" | "vertical";
  /** Set false while another widget owns the keyboard. */
  isActive?: boolean;
  /** Accept 1..n as direct selection (default true). */
  numberKeys?: boolean;
}

export function RadioGroup<T extends string>({
  options,
  value,
  onChange,
  orientation = "horizontal",
  isActive = true,
  numberKeys = true,
}: RadioGroupProps<T>) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));

  useInput(
    (input, key) => {
      const prev = orientation === "horizontal" ? key.leftArrow : key.upArrow;
      const next = orientation === "horizontal" ? key.rightArrow : key.downArrow;
      if (prev && index > 0) onChange(options[index - 1]!.value);
      else if (next && index < options.length - 1) onChange(options[index + 1]!.value);
      else if (numberKeys && /^[1-9]$/.test(input)) {
        const picked = options[Number(input) - 1];
        if (picked) onChange(picked.value);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection={orientation === "horizontal" ? "row" : "column"} columnGap={2}>
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <Box key={option.value}>
            <Text color={selected ? themeColor("accent") : undefined} bold={selected}>
              {selected ? marks.radioOn : marks.radioOff} {option.label}
            </Text>
            {option.badge ? <Text color={themeColor("muted")}> {option.badge}</Text> : null}
            {numberKeys ? <Text color={themeColor("muted")}> {i + 1}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
