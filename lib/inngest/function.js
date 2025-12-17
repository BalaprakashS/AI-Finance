import { inngest } from "./client";
import { db } from "@/lib/prisma";
import EmailTemplate from "@/emails/template";
import { sendEmail } from "@/actions/send-email";

/* -----------------------------------------
   1. Recurring Transaction Processing
------------------------------------------ */

export const processRecurringTransaction = inngest.createFunction(
  {
    id: "process-recurring-transaction",
    name: "Process Recurring Transaction",
    throttle: {
      limit: 10,
      period: "1m",
      key: "event.data.userId",
    },
  },
  { event: "transaction.recurring.process" },
  async ({ event, step }) => {
    if (!event?.data?.transactionId || !event?.data?.userId) {
      console.error("Invalid event data:", event);
      return;
    }

    await step.run("process-transaction", async () => {
      const transaction = await db.transaction.findUnique({
        where: {
          id: event.data.transactionId,
          userId: event.data.userId,
        },
        include: { account: true },
      });

      if (!transaction || !isTransactionDue(transaction)) return;

      await db.$transaction(async (tx) => {
        await tx.transaction.create({
          data: {
            type: transaction.type,
            amount: transaction.amount,
            description: `${transaction.description} (Recurring)`,
            date: new Date(),
            category: transaction.category,
            userId: transaction.userId,
            accountId: transaction.accountId,
            isRecurring: false,
          },
        });

        const balanceChange =
          transaction.type === "EXPENSE"
            ? -transaction.amount.toNumber()
            : transaction.amount.toNumber();

        await tx.account.update({
          where: { id: transaction.accountId },
          data: { balance: { increment: balanceChange } },
        });

        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            lastProcessed: new Date(),
            nextRecurringDate: calculateNextRecurringDate(
              new Date(),
              transaction.recurringInterval
            ),
          },
        });
      });
    });
  }
);

/* -----------------------------------------
   2. Trigger Recurring Transactions (Cron)
------------------------------------------ */

export const triggerRecurringTransactions = inngest.createFunction(
  {
    id: "trigger-recurring-transactions",
    name: "Trigger Recurring Transactions",
  },
  { cron: "0 0 * * *" },
  async ({ step }) => {
    const recurringTransactions = await step.run(
      "fetch-recurring-transactions",
      async () =>
        db.transaction.findMany({
          where: {
            isRecurring: true,
            status: "COMPLETED",
            OR: [
              { lastProcessed: null },
              { nextRecurringDate: { lte: new Date() } },
            ],
          },
        })
    );

    if (!recurringTransactions.length) return;

    await inngest.send(
      recurringTransactions.map((t) => ({
        name: "transaction.recurring.process",
        data: {
          transactionId: t.id,
          userId: t.userId,
        },
      }))
    );
  }
);

/* -----------------------------------------
   3. Monthly Report Generation (Gemini REST)
------------------------------------------ */

async function generateFinancialInsights(stats, month) {
  const prompt = `
Analyze this financial data and provide 3 concise, actionable insights.

Financial Data for ${month}:
- Total Income: $${stats.totalIncome}
- Total Expenses: $${stats.totalExpenses}
- Net Income: $${stats.totalIncome - stats.totalExpenses}
- Expense Categories: ${Object.entries(stats.byCategory)
    .map(([c, a]) => `${c}: $${a}`)
    .join(", ")}

Return ONLY valid JSON:
["insight 1", "insight 2", "insight 3"]
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!res.ok) throw new Error(await res.text());

    const json = await res.json();
    const text =
      json.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";

    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("Gemini insight error:", err);
    return [
      "Review your highest expense category this month.",
      "Setting a budget could improve savings.",
      "Recurring expenses may offer cost-cut opportunities.",
    ];
  }
}

export const generateMonthlyReports = inngest.createFunction(
  {
    id: "generate-monthly-reports",
    name: "Generate Monthly Reports",
  },
  { cron: "0 0 1 * *" },
  async ({ step }) => {
    const users = await step.run("fetch-users", async () =>
      db.user.findMany({ include: { accounts: true } })
    );

    for (const user of users) {
      await step.run(`report-${user.id}`, async () => {
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);

        const stats = await getMonthlyStats(user.id, lastMonth);
        const monthName = lastMonth.toLocaleString("default", {
          month: "long",
        });

        const insights = await generateFinancialInsights(stats, monthName);

        await sendEmail({
          to: user.email,
          subject: `Your Monthly Financial Report - ${monthName}`,
          react: EmailTemplate({
            userName: user.name,
            type: "monthly-report",
            data: { stats, month: monthName, insights },
          }),
        });
      });
    }
  }
);

/* -----------------------------------------
   4. Budget Alerts
------------------------------------------ */

export const checkBudgetAlerts = inngest.createFunction(
  { name: "Check Budget Alerts" },
  { cron: "0 */6 * * *" },
  async ({ step }) => {
    const budgets = await step.run("fetch-budgets", async () =>
      db.budget.findMany({
        include: {
          user: {
            include: {
              accounts: { where: { isDefault: true } },
            },
          },
        },
      })
    );

    for (const budget of budgets) {
      const account = budget.user.accounts[0];
      if (!account) continue;

      await step.run(`alert-${budget.id}`, async () => {
        const startDate = new Date();
        startDate.setDate(1);

        const expenses = await db.transaction.aggregate({
          where: {
            userId: budget.userId,
            accountId: account.id,
            type: "EXPENSE",
            date: { gte: startDate },
          },
          _sum: { amount: true },
        });

        const total = expenses._sum.amount?.toNumber() || 0;
        const percent = (total / budget.amount) * 100;

        if (
          percent >= 80 &&
          (!budget.lastAlertSent ||
            isNewMonth(new Date(budget.lastAlertSent), new Date()))
        ) {
          await sendEmail({
            to: budget.user.email,
            subject: `Budget Alert for ${account.name}`,
            react: EmailTemplate({
              userName: budget.user.name,
              type: "budget-alert",
              data: {
                percentageUsed: percent.toFixed(1),
                budgetAmount: budget.amount.toFixed(1),
                totalExpenses: total.toFixed(1),
                accountName: account.name,
              },
            }),
          });

          await db.budget.update({
            where: { id: budget.id },
            data: { lastAlertSent: new Date() },
          });
        }
      });
    }
  }
);

/* -----------------------------------------
   Helpers
------------------------------------------ */

function isNewMonth(a, b) {
  return a.getMonth() !== b.getMonth() || a.getFullYear() !== b.getFullYear();
}

function isTransactionDue(transaction) {
  if (!transaction.lastProcessed) return true;
  return new Date(transaction.nextRecurringDate) <= new Date();
}

function calculateNextRecurringDate(date, interval) {
  const next = new Date(date);
  if (interval === "DAILY") next.setDate(next.getDate() + 1);
  if (interval === "WEEKLY") next.setDate(next.getDate() + 7);
  if (interval === "MONTHLY") next.setMonth(next.getMonth() + 1);
  if (interval === "YEARLY") next.setFullYear(next.getFullYear() + 1);
  return next;
}

async function getMonthlyStats(userId, month) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 0);

  const transactions = await db.transaction.findMany({
    where: { userId, date: { gte: start, lte: end } },
  });

  return transactions.reduce(
    (acc, t) => {
      const amt = t.amount.toNumber();
      if (t.type === "EXPENSE") {
        acc.totalExpenses += amt;
        acc.byCategory[t.category] =
          (acc.byCategory[t.category] || 0) + amt;
      } else acc.totalIncome += amt;
      return acc;
    },
    { totalIncome: 0, totalExpenses: 0, byCategory: {} }
  );
}
