import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const config = {
    indexName: 'bit-data',
    dimension: 768,
    batchSize: 10,
    chunkSize: 1000
};

const turndownService = new TurndownService();

function cleanText(text) {
    return text.replace(/\s+/g, ' ').trim();
}

async function initServices() {
    try {
        const pinecone = new Pinecone({
            apiKey:'pcsk_48pNCi_7z4viPmEujayoK2jtyFKXXY5uMFR5jMaPYnANZ9GRCQvtVd77jPaT8k6kMwzd6G'
        });

        const genAI = new GoogleGenerativeAI('AIzaSyDd0ktqwKnFOfaQCU0dryXuhcnhiuybXFQ');
        const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

        return { pinecone, embedModel };
    } catch (error) {
        console.error("Error initializing services:", error);
        throw error;
    }
}

async function crawlPage(url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();

            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });

            const content = await page.evaluate(() => {
                // Remove unwanted elements
                const unwanted = document.querySelectorAll('script, style, nav, footer, header, iframe');
                unwanted.forEach(el => el.remove());

                const main = document.querySelector('main') || document.body;
                return main.innerHTML;
            });

            await browser.close();

            const dom = new JSDOM(content);
            const mainContent = dom.window.document.body.textContent;
            return turndownService.turndown(cleanText(mainContent));

        } catch (error) {
            console.error(`Attempt ${attempt} failed for ${url}:`, error);
            if (attempt === retries) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

async function generateEmbedding(text, embedModel) {
    try {
        const embedResult = await embedModel.embedContent(text);
        const embedding = Array.from(await embedResult.embedding.values);
        return embedding;
    } catch (error) {
        console.error("Error generating embedding:", error);
        throw error;
    }
}

async function processAndUpsert(content, url, embedModel, index) {
    const chunks = content.match(new RegExp(`.{1,${config.chunkSize}}`, 'g')) || [];
    let vectors = [];

    for (let i = 0; i < chunks.length; i++) {
        const embedding = await generateEmbedding(chunks[i], embedModel);

        vectors.push({
            id: `${url.replace(/[^a-zA-Z0-9]/g, '_')}_chunk_${i}`,
            values: embedding,
            metadata: {
                url,
                content: chunks[i],
                timestamp: new Date().toISOString()
            }
        });

        if (vectors.length >= config.batchSize) {
            console.log(`Upserting batch of ${vectors.length} vectors...`);
            await index.upsert(vectors);
            console.log('Batch upsert complete');
            vectors = [];
        }
    }

    if (vectors.length > 0) {
        console.log(`Upserting final batch of ${vectors.length} vectors...`);
        await index.upsert(vectors);
        console.log('Final batch upsert complete');
    }
}

async function main() {
    try {
        const { pinecone, embedModel } = await initServices();

        // List of URLs to process
        const urls = [
            'https://www.bitsathy.ac.in/departments/faculty/#information-science-and-engineering'
        ];

        // Get or create index
        let index = pinecone.index(config.indexName);

        // Process each URL
        for (const url of urls) {
            console.log(`\nProcessing ${url}...`);
            try {
                const content = await crawlPage(url);
                await processAndUpsert(content, url, embedModel, index);
            } catch (error) {
                console.error(`Error processing ${url}:`, error);
                continue;
            }
        }

        console.log('\nVerifying index stats...');
        const stats = await index.describeIndexStats();
        console.log('Final index stats:', JSON.stringify(stats, null, 2));

    } catch (error) {
        console.error('Error in main process:', error);
        process.exit(1);
    }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
    process.exit(1);
});

if (import.meta.url === new URL(import.meta.url).href) {
    main();
}

export {
    initServices,
    crawlPage,
    generateEmbedding,
    processAndUpsert,
    main
};