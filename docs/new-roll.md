# Adding a new DYMO roll

A step-by-step guide for a roll the service does not know yet. Swedish: [new-roll.sv.md](new-roll.sv.md).

## Is the roll already known?

The built-in rolls are calibrated and print as soon as they are loaded:

| Article | Label |
| --- | --- |
| S0722540 | 57 × 32 mm |
| S0722550 | 19 × 51 mm (fold-over; prints on the 19 mm face) |
| S0722520 | 25 × 54 mm |
| S0722430 | 54 × 101 mm |
| 2166659 | 102 × 210 mm shipping label |

A roll added earlier is in the Rolls table on the admin page. For those, load the roll, click **Read loaded roll** and **Use the detected format**. Nothing else is needed.

## A new kind of roll

Before you start: close DYMO Connect on every computer that shares the printer. Its background service keeps the printer busy, and a test print can then stop halfway.

### 1. Read the roll and add it

1. Load the roll in the printer.
2. Open the admin page. Under **Printer**, click **Read loaded roll**.
3. Click **Add this roll**. The form fills in the article number, the width and the length from the roll's chip.
4. Check the size with a ruler. Measure the label itself, not the backing. The chip gives the whole label: on a fold-over label, enter only the face that you print on.
5. Click **Add roll**. The roll starts as *testing*. It prints nothing but its test label until you approve it.

### 2. Print the test label

1. In the Rolls table, click **Test print** on the new roll.
2. Click **Use as the loaded roll of this printer**.
3. Click **Prepare test label**, then **Print the test label**.

The test label has a frame of four straight lines, each 5 mm inside its edge (less on very small rolls; the page shows the distance).

### 3. Measure and approve

1. With a calliper, measure each side from the edge of the label to the outer edge of that side's line. Read the sides as the preview shows the label. On a fold-over label, measure from the fold, not from the outer edge of the flap.
2. Enter the four distances: top, right, bottom and left.
3. Click **Approve the test print**. The service moves the image into place and saves the edges that do not print (at least 1 mm on every side).
4. If the page says the distances cannot be right, measure again. A test print can be approved once only; print a new one if you need to start over.

### 4. Check

1. Click **Test again**, then print one more test label.
2. All four distances should now be about 5 mm. Top and bottom can be a few tenths more: a die-cut label is a little longer than its page.
3. If a side is off by more than about 0.3 mm, enter this reading and approve again. Each round makes it more accurate.

### 5. Use the roll in Label Studio

A template is made for one roll, or for any roll.

- For a new template: choose the new roll under **Label format**.
- For an existing template: duplicate it and choose the new roll, or tick **Any roll** so it follows the size of every roll.
- Preview, then publish the template. Only published templates print for ordinary keys.

## Re-measuring a roll

Click **Test again** on the roll at any time, for example after a printer change. Before you approve, the page lists the templates that would reach into the new edges.
