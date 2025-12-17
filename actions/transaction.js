"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

/* -------------------------------
   Helpers
-------------------------------- */

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);
  if (interval === "DAILY") date.setDate(date.getDate() + 1);
  if (interval === "WEEKLY") date.setDate(date.getDate() + 7);
  if (interval === "MONTHLY") date.setMonth(date.getMonth() + 1);
  if (interval === "YEARLY") date.setFullYear(date.getFullYear() + 1);
  return date;
}

/* -------------------------------
   Create Transaction
-------------------------------- */

export async function createTransaction(data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const req = await request();
    const decision = await aj.protect(req, {
      userId,
      requested: 1,
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        throw new Error("Too many requests. Please try again later.");
      }
      throw new Error("Request blocked");
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const account = await db.account.findUnique({
      where: { id: data.accountId, userId: user.id },
    });
    if (!account) throw new Error("Account not found");

    const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
    const newBalance = account.balance.toNumber() + balanceChange;

    const transaction = await db.$transaction(async (tx) => {
      const newTx = await tx.transaction.create({
        data: {
          ...data,
          userId: user.id,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: { balance: newBalance },
      });

      return newTx;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

/* -------------------------------
   Read / Update Transactions
-------------------------------- */

export async function getTransaction(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (!user) throw new Error("User not found");

  const transaction = await db.transaction.findUnique({
    where: { id, userId: user.id },
  });
  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

export async function updateTransaction(id, data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const original = await db.transaction.findUnique({
      where: { id, userId: user.id },
      include: { account: true },
    });
    if (!original) throw new Error("Transaction not found");

    const oldChange =
      original.type === "EXPENSE"
        ? -original.amount.toNumber()
        : original.amount.toNumber();

    const newChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netChange = newChange - oldChange;

    const updated = await db.$transaction(async (tx) => {
      const txUpdated = await tx.transaction.update({
        where: { id, userId: user.id },
        data: {
          ...data,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: { balance: { increment: netChange } },
      });

      return txUpdated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(updated) };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getUserTransactions(query = {}) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });
  if (!user) throw new Error("User not found");

  const transactions = await db.transaction.findMany({
    where: { userId: user.id, ...query },
    include: { account: true },
    orderBy: { date: "desc" },
  });

  return { success: true, data: transactions };
}

/* -------------------------------
   Scan Receipt (Gemini 2.5 Flash)
-------------------------------- */

export async function scanReceipt(file) {
  try {
    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: file.type,
                    data: base64,
                  },
                },
                {
                  text: `
Extract receipt details and return ONLY valid JSON:
{
  "amount": number,
  "date": "ISO date string",
  "description": "string",
  "merchantName": "string",
  "category": "string"
}
                  `,
                },
              ],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const json = await response.json();
    const text =
      json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    const cleaned = text.replace(/```json|```/g, "").trim();
    const data = JSON.parse(cleaned);

    return {
      amount: Number(data.amount),
      date: new Date(data.date),
      description: data.description,
      merchantName: data.merchantName,
      category: data.category,
    };
  } catch (error) {
    console.error("Error scanning receipt:", error);
    throw new Error("Failed to scan receipt");
  }
}
