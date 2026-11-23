# MCA lifetime leaderboard data

Each CSV here represents **one completed Multi-Club Arena**.

Use Chess.com's **Download CSV** option on the completed tournament's results page.
Keep the original tournament ID at the end of its filename, for example:

`blundering-buddies-blitz-3-0-unrated-multiclub-31118732.csv`

The files must contain the columns `Username`, `Club`, `Score`, and `Status`,
as included in Chess.com's MCA standings export. The exporter includes a
second table with overall club totals; the importer ignores those rows.

**To update the sidebar:**

1. On GitHub, open `data/mca-results/` in this repository.
2. Choose **Add file → Upload files**, select the new MCA CSV, and commit it.
3. GitHub Actions automatically recalculates `mca-lifetime-points.json`.
4. The GitHub Pages sidebar displays the updated all-time rankings.

You can also choose **Actions → Update MCA Lifetime Leaderboard → Run workflow**.

Important details:

- The import counts only players whose exported **Club** is **Blundering Buddies**.
- Chess.com sometimes labels scoring players `winner` or `withdrew`; these
  points count. A `removed` result can also remain in a historical club total.
  The importer matches each tournament's official club-points summary and
  refuses to publish an event if the scores cannot be reconciled.
- A tournament ID can appear only once, preventing accidental double counting.
- A new file adds an MCA; replacing an existing CSV corrects its scores.
- GitHub repositories are public unless you've configured them otherwise.
  Chess.com's raw CSV may contain optional names. If you want to avoid putting
  those names in Git history, first keep only Username, Club, Score, Status,
  and the club-summary rows, as in the example event file.
