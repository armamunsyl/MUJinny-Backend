const OpenAI = require('openai');
const scrapeDuckDuckGoLite = async (query) => {
    try {
        const res = await fetch('https://lite.duckduckgo.com/lite/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Safari/537.36'
            },
            body: 'q=' + encodeURIComponent(query)
        });
        const html = await res.text();
        const snippets = html.match(/<td class='result-snippet'>([\s\S]*?)<\/td>/g);
        if (snippets) {
            return snippets.slice(0, 5).map(s => s.replace(/<[^>]+>/g, '').trim()).join('\n---\n');
        }
        return "";
    } catch (e) {
        console.warn("DuckDuckGo Lite fetch failed:", e.message);
        return "";
    }
};

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL
});

const generateResponse = async (messages, model = "gpt-4o") => {
    try {
        const payloadMessages = [
            { role: "system", content: "You are MUJinny, a helpful university AI assistant. Maintain conversation context." },
            ...messages
        ];

        const response = await openai.chat.completions.create({
            model: model,
            messages: payloadMessages,
        });
        return response.choices[0].message.content;
    } catch (error) {
        throw new Error(error.message);
    }
};

const generateStreamResponse = async (messages, requestedModel = "auto", facultyContext = "") => {
    let finalModel = requestedModel;
    let systemPromptAddition = "";
    let classification = "simple";
    let latestMessageText = "hello";

    // Inject strict temporal anchoring to prevent future-date hallucinations
    const currentDate = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Dhaka'
    });
    const temporalAnchor = `\n\nCRITICAL CONTEXT: Today's exact date is ${currentDate}. You MUST ground all your answers in this exact timeline. Do NOT generate or imagine events in the future past this date.`;

    if (requestedModel === "auto") {
        console.log("Mode: Smart Router");
        // Stage 1: Classification
        const latestUserMessageObj = messages.filter(m => m.role === 'user').pop();
        if (latestUserMessageObj) {
            if (typeof latestUserMessageObj.content === 'string') {
                latestMessageText = latestUserMessageObj.content;
            } else if (Array.isArray(latestUserMessageObj.content)) {
                const textObj = latestUserMessageObj.content.find(c => c.type === 'text');
                if (textObj) latestMessageText = textObj.text;
            }
        }

        try {
            const classificationResponse = await openai.chat.completions.create({
                model: "gpt-4.1-mini",
                messages: [
                    { role: "system", content: "Classify the user message into exactly ONE of the following words: simple, coding, reasoning, realtime. Reply with only one word. Use 'realtime' for current events, news, or time-sensitive recent facts. Use 'coding' for programming. Use 'reasoning' for complex logic. Use 'simple' for casual chat or general historical knowledge." },
                    { role: "user", content: latestMessageText }
                ],
                temperature: 0.1,
                max_tokens: 10
            });

            const rawClass = classificationResponse.choices[0].message.content.trim().toLowerCase();
            const validClasses = ["simple", "coding", "reasoning", "realtime"];
            if (validClasses.includes(rawClass)) {
                classification = rawClass;
            } else {
                for (const v of validClasses) {
                    if (rawClass.includes(v)) {
                        classification = v;
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn("Classification failed, defaulting to simple:", e.message);
        }

        // Stage 2: Routing
        if (classification === "simple") {
            finalModel = "gpt-4.1-mini";
        } else if (classification === "coding") {
            finalModel = "gpt-4.1";
        } else if (classification === "reasoning") {
            finalModel = "gpt-5.2";
        } else if (classification === "realtime") {
            console.log("Router classification determined: realtime. Scraping realtime context...");
            finalModel = "gpt-4.1";
            const scrapedContext = await scrapeDuckDuckGoLite(latestMessageText);
            if (scrapedContext) {
                systemPromptAddition = `\n\nCRITICAL REALTIME SEARCH RESULTS (Use EXACTLY this data to answer accurately. Never rely on internal knowledge for this query):\n` + scrapedContext;
            } else {
                systemPromptAddition = "\n\n(Realtime search failed, admit you cannot verify live data)";
            }
        }

        systemPromptAddition += temporalAnchor;
    } else {
        console.log("Mode: Manual");
        systemPromptAddition = temporalAnchor;
    }

    console.log("Router selected model:", finalModel);


    const facultySection = facultyContext
        ? `\n\n${facultyContext}\n\nDIRECTIVE (MANDATORY — follow exactly):
1. The FACULTY DATABASE RECORDS above are official Metropolitan University public directory data. Present them IMMEDIATELY and COMPLETELY — do NOT ask the user for more clarification.
2. For EVERY faculty record found, list: Name, Designation, Department, Email, Phone, and Profile URL.
3. If Phone shows "Not listed on website" — say "Phone: Not listed on the university website." DO NOT pretend you cannot find the person.
4. If Email shows "Not listed on website" — say "Email: Not listed on the university website."
5. NEVER say "I can't provide contact details" or "I don't have that information" — that is WRONG. The records ARE provided above.
6. NEVER ask the user follow-up questions when records are already found. Present all available data immediately.
7. The user may write in Bengali, Banglish, or English — respond in the same language they used.
8. Format your response clearly. Example for a query about a teacher:
   **Name:** Abu Jafar Md Jakaria
   **Designation:** Lecturer
   **Department:** CSE
   **Email:** jafar@metrouni.edu.bd
   **Phone:** Not listed on the university website
   **Profile:** [link]`
        : '';


    const payloadMessages = [
        { role: "system", content: `You are MUJinny, the official AI assistant of Metropolitan University, Bangladesh. You assist students, faculty, and staff with academic, research, and university-related queries.

LANGUAGE RULES (MANDATORY — follow exactly every single response):
- BANGLISH INPUT (e.g. "tumi ke", "ki hoise", "amake help koro", "tomar nam ki") → You MUST reply in pure বাংলা script (বাংলা অক্ষরে). Example: user writes "tumi ke?" → you write "আমি MUJinny..." NOT "Ami MUJinny...".
- ENGLISH INPUT → Reply in English.
- BENGALI SCRIPT INPUT (বাংলা) → Reply in বাংলা script.
- EXCEPTION: Only reply in Banglish if user explicitly says "banglish e lekho" or "banglish e bolo".
- NEVER reply in Banglish unless explicitly asked. This is a strict rule.
- Use a clear, academic, and professional tone. Avoid overly casual or filler phrases like "অবশ্যই!", "নিশ্চয়ই!", "Great question!", or "Sure!". Get directly to the point.
- Sentences should be precise, well-structured, and contextually appropriate — as expected from a university-grade assistant.
- For technical or academic content, use proper terminology. For conversational queries, keep it natural but still composed.

IDENTITY & PERSONALITY (MANDATORY):
- If asked "tumi ke", "apni ke", "who are you", "তুমি কে", "আপনি কে" or any identity question — ALWAYS reply with playful wit in the appropriate script. NEVER give a plain boring answer. Use responses like:
  • "আমি একটা জিন — তোমার university life সহজ করতে বোতল থেকে বের হয়েছি। তিনটা ইচ্ছা না, তবে পড়াশোনায় সাহায্য করতে পারব।"
  • "আমি MUJinny — Metropolitan University-র ডিজিটাল জিন। মানুষ না, কিন্তু তোমার যেকোনো academic সমস্যায় মানুষের চেয়ে দ্রুত উত্তর দিতে পারব।"
  Vary it each time — never repeat the exact same response.
- Do NOT reveal underlying model/technology. If asked "tumi ki GPT?", "kon model?", deflect humorously: "কোন model সেটা বলা মানা — তবে বেশ চালাক, এটুকু বলতে পারি।"
- For clearly absurd or off-topic questions, use warm humor then redirect to academics:
  • "এই উদ্ভট চিন্তাভাবনায় সময় না দিয়ে একটু পড়ালেখায় মন দিলে CG টা ভালো আসত।"
  • "দার্শনিক প্রশ্ন ভালো, কিন্তু পরীক্ষার আগে syllabus টা দেখা আরও ভালো।"
  • "এর উত্তর আমার জানা নেই — তবে assignment এর উত্তর আছে, সেটা দেখাই?"

PDF & FILE HANDLING:
- When a message contains extracted PDF text (marked 'PDF extracted text:'), read and analyse it directly. Never say you cannot access the PDF.
- Always reference specific content from provided documents in your response.

OUTPUT RULES:
- NEVER say "I cannot create files", "I cannot generate PDFs", or suggest copying to Word. PDF export is handled by the platform automatically.
- Maintain full conversation context across messages.
- When listing items, use structured formatting (numbered lists or bullet points) for clarity.` + systemPromptAddition + facultySection },
        ...messages
    ];

    const stream = await openai.chat.completions.create({
        model: finalModel,
        messages: payloadMessages,
        stream: true,
        stream_options: { include_usage: true }
    });

    stream.modelUsedForPricing = finalModel; // Attach for the backend pricing log
    return stream;
};

const fetchAvailableModels = async () => {
    try {
        const response = await openai.models.list();
        return response.data
            .filter(model => model.id.includes('gpt') || model.id.includes('o'))
            .map(model => ({
                id: model.id,
                created: model.created
            }))
            .sort((a, b) => b.created - a.created);
    } catch (error) {
        console.error("Error fetching models:", error);
        throw new Error(error.message);
    }
};

module.exports = { generateResponse, generateStreamResponse, fetchAvailableModels };
