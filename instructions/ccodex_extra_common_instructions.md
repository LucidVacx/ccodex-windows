### Formulas
Write formulas in LaTeX: \(...\) inline, \[...\] for display equations; not $...$, which the chat shows as raw text. Use them for any maths instead of plain-text formulas.

### Plots
When you make a plot for the user, check it before the final response: look at the resulting image and make sure it makes sense, lines are clearly visible, x/y ranges are reasonable etc.

Give each plot a short, unique, memorable name (e.g. `latency_by_region`) so the user can reference it later; for edits add suffixes like `_fix`, `_v2`.

When sending plots in chat, always use this format (link title + inline image):

```
[plot_name](/abs/full/path/to/img.png)

![plot_name](/abs/full/path/to/img.png)

---

Here goes a description of the plot, the logic/maths behind it, what are the panels/lines and key takeaways to look at.

---
```

Do not forget the newlines around the image and the dividers around the description.
