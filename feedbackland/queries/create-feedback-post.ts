"server-only";

import { db } from "@/db/db";
import { FeedbackCategory } from "@/lib/typings";
import {
  clean,
  generateSQLEmbedding,
  getImageUrls,
  getPlainText,
  hasOpenRouterKey,
  isInappropriateCheck,
  LLM_MODEL,
  REASONING,
} from "@/lib/utils-server";

const getTitleAndCategory = async ({ plainText }: { plainText: string }) => {
  // OPENROUTER_API_KEY 未配置或 LLM 调用失败时降级：截断原文作标题、归类
  // general feedback——反馈提交不因外部 AI 服务不可用而阻塞（自托管场景）
  const fallback = () => ({
    title: plainText.replace(/\s+/g, " ").trim().slice(0, 60) || "未命名反馈",
    category: "general feedback" as FeedbackCategory,
  });

  if (!hasOpenRouterKey()) {
    return fallback();
  }

  try {
    const prompt = `
      You are an expert at creating concise, natural-sounding titles and categorizing descriptions.
      Given a description provided by a user, create a short title that sounds like it was written by a human.
      Also categorize the description as either a 'idea', 'issue' or 'general feedback'.

      You MUST respond with only a valid JSON object that exactly matches the following schema:
      {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "A brief human-like title"
          },
          "category": {
            "type": "string",
            "enum": ["idea", "issue", "general feedback"],
            "description": "The category of the feedback"
          }
        },
        "required": ["title", "category"],
        "additionalProperties": false
      }

      An example of what the output JSON object may look like:
      {
        "title": "Add a dark mode to the UI",
        "category": "idea"
      }

      Remember: Return ONLY the JSON object, nothing else!
    `;

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            {
              role: "system",
              content: prompt,
            },
            {
              role: "user",
              content: plainText,
            },
          ],
          // Runs alongside the moderation check while the author waits. A title
          // and a three-way label do not need deliberation.
          reasoning: REASONING.mechanical,
          response_format: { type: "json_object" },
        }),
      },
    );

    const data = await response.json();

    const content = data.choices[0]?.message?.content || "";

    const parsedContent = JSON.parse(content) as {
      title: string;
      category: FeedbackCategory;
    };

    const { title, category } = parsedContent;

    return { title, category };
  } catch (error) {
    // LLM 限流/网络/余额等异常不阻塞反馈提交，降级为机械标题
    console.warn(
      "[create-feedback-post] LLM 起标题/分类失败，使用降级标题:",
      error instanceof Error ? error.message : error
    );
    return fallback();
  }
};

export async function createFeedbackPostQuery({
  description,
  authorId,
  orgId,
}: {
  description: string;
  authorId: string | null;
  orgId: string;
}) {
  try {
    const imageUrls = getImageUrls(description);
    const plainText = getPlainText(description);

    const [isInappropriate, { title, category }] = await Promise.all([
      isInappropriateCheck({
        orgId,
        plainText,
        imageUrls,
      }),
      getTitleAndCategory({
        plainText,
      }),
    ]);

    if (isInappropriate) {
      throw new Error("inappropriate-content");
    }

    const embedding = await generateSQLEmbedding(`${title}: ${plainText}`);

    const feedbackPost = await db
      .insertInto("feedback")
      .values({
        title,
        description: clean(description),
        category,
        authorId,
        orgId,
        embedding,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return feedbackPost;
  } catch (error) {
    throw error;
  }
}
