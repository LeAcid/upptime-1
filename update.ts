import { Octokit } from "@octokit/rest";
import slugify from "@sindresorhus/slugify";
import { readFile } from "fs-extra";
import { safeLoad } from "js-yaml";
import { Curl, CurlFeature } from "node-libcurl";
import { join } from "path";
import { generateSummary } from "./summary";

const shouldCommit = process.argv[2] === "commit";

export const update = async () => {
  const config = safeLoad(
    await readFile(join(".", ".statusrc.yml"), "utf8")
  ) as {
    sites: string[];
    owner: string;
    repo: string;
    userAgent?: string;
    PAT?: string;
    assignees?: string[];
  };
  const owner = config.owner;
  const repo = config.repo;

  const octokit = new Octokit({
    auth: config.PAT || process.env.GH_PAT || process.env.GITHUB_TOKEN,
    userAgent: config.userAgent || process.env.USER_AGENT || "KojBot",
  });

  let hasDelta = false;
  for await (const url of config.sites) {
    const slug = slugify(url.replace(/(^\w+:|^)\/\//, ""));
    console.log("Checking", url);
    let currentStatus = "unknown";
    let startTime = new Date().toUTCString();
    try {
      currentStatus =
        (await readFile(join(".", "history", `${slug}.yml`), "utf8"))
          .split("\n")
          .find((line) => line.toLocaleLowerCase().includes("- status"))
          ?.split(":")[1]
          .trim() || "unknown";
      startTime =
        (await readFile(join(".", "history", `${slug}.yml`), "utf8"))
          .split("\n")
          .find((line) => line.toLocaleLowerCase().includes("- startTime"))
          ?.split(":")[1]
          .trim() || new Date().toUTCString();
    } catch (error) {}
    try {
      const result = await curl(url);
      console.log("Result", result);
      const responseTime = (result.totalTime * 1000).toFixed(0);
      const status =
        result.httpCode >= 400 || result.httpCode < 200 ? "down" : "up";

      if (shouldCommit || currentStatus !== status) {
        const content = `- url: ${url}
- status: ${status}
- code: ${result.httpCode}
- responseTime: ${responseTime}
- lastUpdated: ${new Date().toISOString()}
- startTime: ${startTime}
`;

        let sha: string | undefined = "";
        try {
          sha = (
            await octokit.repos.getContent({
              owner,
              repo,
              path: `history/${slug}.yml`,
            })
          ).data.sha;
        } catch (error) {}
        const fileUpdateResult = await octokit.repos.createOrUpdateFileContents(
          {
            owner,
            repo,
            path: `history/${slug}.yml`,
            message: `${status === "up" ? "🟩" : "🟥"} ${url} is ${status} (${
              result.httpCode
            } in ${responseTime}ms) [skip ci]`,
            content: Buffer.from(content).toString("base64"),
            sha,
          }
        );

        if (currentStatus !== status) {
          console.log("Status is different", currentStatus, "to", status);
          hasDelta = true;

          const issues = await octokit.issues.list({
            owner,
            repo,
            labels: slug,
            filter: "all",
            state: "open",
            sort: "created",
            direction: "desc",
            per_page: 1,
          });
          console.log(`Found ${issues.data.length} issues`);

          // If the site was just recorded as down, open an issue
          if (status === "down") {
            if (!issues.data.length) {
              await octokit.issues.create({
                owner,
                repo,
                title: `⚠️ ${url} is down`,
                body: `In ${fileUpdateResult.data.commit.sha.substr(
                  0,
                  7
                )}, ${url} was **down**:

- HTTP code: ${result.httpCode}
- Response time: ${responseTime} ms
`,
                assignees: config.assignees,
                labels: ["status", slug],
              });
              console.log("Opened a new issue");
            } else {
              console.log("An issue is already open for this");
            }
          } else if (issues.data.length) {
            // If the site just came back up
            await octokit.issues.createComment({
              owner,
              repo,
              issue_number: issues.data[0].number,
              body: `${url} is back up in ${fileUpdateResult.data.commit.sha.substr(
                0,
                7
              )}.`,
            });
            console.log("Created comment in issue");
            await octokit.issues.update({
              owner,
              repo,
              issue_number: issues.data[0].number,
              state: "closed",
            });
            console.log("Closed issue");
          } else {
            console.log("Could not find a relevant issue", issues.data);
          }
        } else {
          console.log("Status is the same", currentStatus, status);
        }
      } else {
        console.log("Skipping commit, ", "status is", status);
      }
    } catch (error) {
      console.log("ERROR", error);
    }
  }

  if (hasDelta) generateSummary();
};

const curl = (url: string): Promise<{ httpCode: number; totalTime: number }> =>
  new Promise((resolve) => {
    const curl = new Curl();
    curl.enable(CurlFeature.Raw);
    curl.setOpt("URL", url);
    curl.setOpt("FOLLOWLOCATION", 1);
    curl.setOpt("MAXREDIRS", 3);
    curl.setOpt("USERAGENT", "Koj Bot");
    curl.setOpt("CONNECTTIMEOUT", 10);
    curl.setOpt("TIMEOUT", 30);
    curl.setOpt("HEADER", 1);
    curl.setOpt("VERBOSE", false);
    curl.setOpt("CUSTOMREQUEST", "GET");
    curl.on("error", () => {
      curl.close();
      return resolve({ httpCode: 0, totalTime: 0 });
    });
    curl.on("end", () => {
      let httpCode = 0;
      let totalTime = 0;
      try {
        httpCode = Number(curl.getInfo("RESPONSE_CODE"));
        totalTime = Number(curl.getInfo("TOTAL_TIME"));
      } catch (error) {
        curl.close();
        return resolve({ httpCode, totalTime });
      }
      return resolve({ httpCode, totalTime });
    });
    curl.perform();
  });

update();
