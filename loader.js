import { Pinecone } from '@pinecone-database/pinecone';
import FirecrawlApp from '@mendable/firecrawl-js';
import { GoogleGenerativeAI } from "@google/generative-ai";

const config = {
    indexName: 'bit',
    dimension: 768,
    batchSize: 10,
    namespace: 'default',
    minChunkSize: 100,
    maxHeaderLevel: 2
};

async function initServices() {
    try {
        const pinecone = new Pinecone({
            apiKey: 'pcsk_48pNCi_7z4viPmEujayoK2jtyFKXXY5uMFR5jMaPYnANZ9GRCQvtVd77jPaT8k6kMwzd6G'
        });
        
        const firecrawl = new FirecrawlApp({
            apiKey:'fc-e5714cb3fabc4f33b47f8a746d788f74'
        });

        const genAI = new GoogleGenerativeAI('AIzaSyDd0ktqwKnFOfaQCU0dryXuhcnhiuybXFQ');
        const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });

        return { pinecone, firecrawl, embeddingModel };
    } catch (error) {
        console.error("Error initializing services:", error);
        throw error;
    }
}



function splitMarkdownIntoChunks(markdownContent) {
    const sections = [];
    let currentHeader = '';
    let currentContent = [];
    let currentLevel = 0;
    let headersStack = [];

    const lines = markdownContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);

        if (headerMatch) {
            const headerLevel = headerMatch[1].length;
            const headerText = headerMatch[2];
            
            if (headerLevel <= config.maxHeaderLevel) {
                // Save previous section if it exists
                if (currentContent.length > 0) {
                    const content = currentContent.join('\n').trim();
                    if (content.length >= config.minChunkSize) {
                        sections.push({
                            header: headerText,
                            content: content,
                            level: currentLevel,
                            headers: [...headersStack]
                        });
                    }
                }

                
                while (headersStack.length >= headerLevel) {
                    headersStack.pop();
                }
                headersStack.push(headerText);

                currentHeader = headerText;
                currentContent = [];
                currentLevel = headerLevel;
            }
        } else if (line !== '') {
            if (!line.startsWith('---') && 
                !line.startsWith('===') && 
                !line.match(/^\[.*\]:/) && 
                !line.match(/^!\[.*\]/)
            ) {
                currentContent.push(line);
            }
        }
    }

  
    if (currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        if (content.length >= config.minChunkSize) {
            sections.push({
                header: currentHeader || 'Conclusion',
                content: content,
                level: currentLevel,
                headers: [...headersStack]
            });
        }
    }

    
    const enrichedSections = buildHeaderHierarchy(sections);

    console.log(`Generated ${enrichedSections.length} markdown sections`);
    if (enrichedSections.length > 0) {
        console.log('First section preview:', {
            fullHeaderPath: enrichedSections[0].fullHeaderPath,
            contentPreview: enrichedSections[0].content.substring(0, 100) + '...',
            level: enrichedSections[0].level
        });
    }

    return enrichedSections;
}

async function crawlPage(url, firecrawl) {
    try {
        console.log('Starting crawl for:', url);
        const crawlResponse = await firecrawl.crawlUrl(url, {
            limit: 100,
            scrapeOptions: {
                formats: ['markdown']
            }
        });

        if (!crawlResponse.success) {
            throw new Error(`Failed to crawl: ${crawlResponse.error}`);
        }

        let markdownContent = '';
        if (Array.isArray(crawlResponse.data)) {
            markdownContent = crawlResponse.data
                .map(item => item.markdown || '')
                .join('\n\n');
        } else if (typeof crawlResponse.data === 'string') {
            markdownContent = crawlResponse.data;
        } else if (crawlResponse.data?.markdown) {
            markdownContent = crawlResponse.data.markdown;
        }

        const structuredChunks = splitMarkdownIntoChunks(markdownContent);
        
        if (structuredChunks.length === 0) {
            throw new Error('No valid content chunks were generated from the page');
        }

        return structuredChunks;

    } catch (error) {
        console.error(`Error crawling ${url}:`, error);
        throw error;
    }
}

async function generateEmbeddings(chunks, embeddingModel) {
    const embeddings = [];
    for (const chunk of chunks) {
        try {
            
            const textToEmbed = `${chunk.fullHeaderPath}\n\n${chunk.content}`;
            const result = await embeddingModel.embedContent(textToEmbed);
            embeddings.push(result.embedding.values);
        } catch (error) {
            console.error("Error generating embedding:", error);
            throw error;
        }
    }
    
    return embeddings;
}

async function processAndUpsert(chunks, url, pinecone, index, embeddingModel) {
    try {
        if (!chunks || chunks.length === 0) {
            throw new Error('No chunks provided for processing');
        }

        console.log(`Processing ${chunks.length} chunks for embedding`);
        
        
        const embeddings = await generateEmbeddings(chunks, embeddingModel);

        const records = chunks.map((chunk, i) => ({
            id: `${url.replace(/[^a-zA-Z0-9]/g, '_')}_chunk_${i}`,
            values: embeddings[i],
            metadata: {
                url,
                header: chunk.header || '',
                fullHeaderPath: chunk.fullHeaderPath || '',
                parentHeader: chunk.parentHeader || '', 
                headerLevel: chunk.level || 0,
                content: chunk.content || '',
                timestamp: new Date().toISOString()
            }
        }));

        
        records.forEach(record => {
            
            Object.keys(record.metadata).forEach(key => {
                if (record.metadata[key] === null || record.metadata[key] === undefined) {
                    record.metadata[key] = ''; 
                }
            });
        });

        for (let i = 0; i < records.length; i += config.batchSize) {
            const batch = records.slice(i, i + config.batchSize);
            console.log(`Upserting batch ${i / config.batchSize + 1} of ${Math.ceil(records.length / config.batchSize)}...`);
            await index.namespace(config.namespace).upsert(batch);
        }

        console.log(`Completed processing ${url}`);
        return records.length;
    } catch (error) {
        console.error("Error in processAndUpsert:", error);
        throw error;
    }
}

function buildHeaderHierarchy(sections) {
    const hierarchy = [];
    const headerStack = [];

    for (const section of sections) {
        const currentLevel = section.level;

        while (
            headerStack.length > 0 && 
            headerStack[headerStack.length - 1].level >= currentLevel
        ) {
            headerStack.pop();
        }

        const parentHeaders = headerStack.map(h => h.header).join(' > ');
        const fullHeader = parentHeaders 
            ? `${parentHeaders} > ${section.header}`
            : section.header || ''; 
        const enrichedSection = {
            ...section,
            fullHeaderPath: fullHeader,
            parentHeader: parentHeaders || ''  
        };

        hierarchy.push(enrichedSection);
        headerStack.push({
            header: section.header || '',
            level: currentLevel
        });
    }

    return hierarchy;
}




async function main() {
    try {
        const { pinecone, firecrawl, embeddingModel } = await initServices();

        const urls = [
            'https://www.bitsathy.ac.in/achievements/'
        ];

        const index = pinecone.index(config.indexName);
        
        for (const url of urls) {
            console.log(`\nProcessing ${url}...`);
            try {
                const chunks = await crawlPage(url, firecrawl);
                console.log(`Found ${chunks.length} content sections`);
                const processedCount = await processAndUpsert(chunks, url, pinecone, index, embeddingModel);
                console.log(`Successfully processed ${processedCount} chunks from ${url}`);
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
    processAndUpsert,
    main
};