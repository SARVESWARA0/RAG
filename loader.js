import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs/promises';
import path from 'path';

const config = {
    indexName: 'bit',
    dimension: 768,
    batchSize: 10,
    recordsPerNamespace: 300,
    wordsPerChunk: 1000
};

async function initServices() {
    try {
        const pinecone = new Pinecone({
            apiKey: 'pcsk_48pNCi_7z4viPmEujayoK2jtyFKXXY5uMFR5jMaPYnANZ9GRCQvtVd77jPaT8k6kMwzd6G'
        });

        const genAI = new GoogleGenerativeAI('AIzaSyDd0ktqwKnFOfaQCU0dryXuhcnhiuybXFQ');
        const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const index = pinecone.index(config.indexName);

        return { pinecone, embeddingModel, index };
    } catch (error) {
        console.error("Error initializing services:", error);
        throw error;
    }
}

function splitTextIntoChunks(text) {
    if (!text || text.trim().length === 0) {
        console.log("Received empty or whitespace-only text");
        return [];
    }

    const words = text.split(/\s+/).filter(word => word.length > 0);
    const chunks = [];
    
    for (let i = 0; i < words.length; i += config.wordsPerChunk) {
        const chunk = words.slice(i, i + config.wordsPerChunk).join(' ');
        if (chunk.trim().length > 0) {
            chunks.push({
                content: chunk,
                wordCount: chunk.split(/\s+/).length
            });
        }
    }
    
    return chunks;
}

async function readAndProcessFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        
        if (!content || content.trim().length === 0) {
            throw new Error('File is empty or contains only whitespace');
        }

        return splitTextIntoChunks(content);
    } catch (error) {
        console.error(`Error processing file ${filePath}:`, error);
        throw error;
    }
}

async function generateEmbeddings(chunks, embeddingModel) {
    try {
        const embeddings = [];
        // Process chunks in parallel with a concurrency limit
        const batchSize = 5; // Adjust based on API limits
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const promises = batch.map(chunk => 
                embeddingModel.embedContent(chunk.content)
                    .then(result => ({
                        embedding: result.embedding.values,
                        content: chunk.content,
                        wordCount: chunk.wordCount
                    }))
            );
            const results = await Promise.all(promises);
            embeddings.push(...results);
        }
        return embeddings;
    } catch (error) {
        console.error("Error in batch embedding generation:", error);
        throw error;
    }
}

async function getCurrentNamespaceCount(index, namespace) {
    try {
        const stats = await index.describeIndexStats({
            filter: { namespace: namespace }
        });
        return stats.namespaces[namespace]?.recordCount || 0;
    } catch (error) {
        console.error(`Error getting namespace count:`, error);
        return 0;
    }
}

async function getNextNamespace(index, baseNamespace = 'default') {
    let namespaceIndex = 1;
    let currentNamespace = baseNamespace;
    
    while (true) {
        const count = await getCurrentNamespaceCount(index, currentNamespace);
        
        if (count < config.recordsPerNamespace) {
            return { namespace: currentNamespace, currentCount: count };
        }
        
        namespaceIndex++;
        currentNamespace = `${baseNamespace}_${namespaceIndex}`;
    }
}

async function processAndUpsert(chunks, fileName, index, embeddingModel) {
    const results = new Map();
    const embeddingsWithMetadata = await generateEmbeddings(chunks, embeddingModel);
    let currentBatch = [];
    let currentNamespaceInfo = await getNextNamespace(index);
    let processedCount = 0;
    
    console.log(`Starting with namespace: ${currentNamespaceInfo.namespace}`);
    
    for (const embedData of embeddingsWithMetadata) {
        // Check if current namespace is full
        if (currentNamespaceInfo.currentCount >= config.recordsPerNamespace) {
            // Process remaining batch if any
            if (currentBatch.length > 0) {
                await index.namespace(currentNamespaceInfo.namespace).upsert(currentBatch);
            }
            
            // Get next namespace
            currentNamespaceInfo = await getNextNamespace(index);
            currentBatch = [];
            console.log(`Switching to namespace: ${currentNamespaceInfo.namespace}`);
        }

        const record = {
            id: `${fileName.replace(/[^a-zA-Z0-9]/g, '_')}_chunk_${processedCount}`,
            values: embedData.embedding,
            metadata: {
                fileName,
                content: embedData.content,
                wordCount: embedData.wordCount,
                namespace: currentNamespaceInfo.namespace,
                timestamp: new Date().toISOString()
            }
        };

        currentBatch.push(record);
        currentNamespaceInfo.currentCount++;
        processedCount++;

        // Track results
        if (!results.has(currentNamespaceInfo.namespace)) {
            results.set(currentNamespaceInfo.namespace, 0);
        }
        results.set(
            currentNamespaceInfo.namespace, 
            results.get(currentNamespaceInfo.namespace) + 1
        );

        // Process batch if it reaches the batch size
        if (currentBatch.length >= config.batchSize) {
            try {
                await index.namespace(currentNamespaceInfo.namespace).upsert(currentBatch);
                console.log(`Processed batch of ${currentBatch.length} records in namespace ${currentNamespaceInfo.namespace}`);
                currentBatch = [];
            } catch (error) {
                console.error(`Error upserting batch to namespace ${currentNamespaceInfo.namespace}:`, error);
                throw error;
            }
        }
    }

    // Process any remaining records in the last batch
    if (currentBatch.length > 0) {
        try {
            await index.namespace(currentNamespaceInfo.namespace).upsert(currentBatch);
            console.log(`Processed final batch of ${currentBatch.length} records in namespace ${currentNamespaceInfo.namespace}`);
        } catch (error) {
            console.error(`Error upserting final batch to namespace ${currentNamespaceInfo.namespace}:`, error);
            throw error;
        }
    }

    return results;
}

async function main() {
    try {
        const { pinecone, embeddingModel, index } = await initServices();
        
        const filePath = './data.txt';
        const fileName = path.basename(filePath);
        
        console.log(`\nProcessing file: ${filePath}`);
        
        const chunks = await readAndProcessFile(filePath);
        const results = await processAndUpsert(chunks, fileName, index, embeddingModel);
        
        console.log('\nProcessing results:');
        for (const [namespace, count] of results.entries()) {
            console.log(`${namespace}: ${count} chunks processed`);
        }

        const stats = await index.describeIndexStats();
        console.log('\nFinal index stats:', JSON.stringify(stats, null, 2));

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
    readAndProcessFile,
    processAndUpsert,
    main
};