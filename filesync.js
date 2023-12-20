const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const bodyParser = require('body-parser');
const { BlobServiceClient } = require('@azure/storage-blob');
const config = require('./config/config')

const app = express();

const azureConnectionString = config.azureConnectionString;
const azureUsercontentUrlPrefix = config.azureUsercontentUrlPrefix;

const blobServiceClient = BlobServiceClient.fromConnectionString(config.azureConnectionString);
const blobContainerClient = blobServiceClient.getContainerClient(config.azureStorageContainerName);
global.blobContainerClient = blobContainerClient;

const remoteDirectoryURL = config.remoteDirectoryURL;
const localDirectory = config.localDirectory;

app.use(bodyParser.json())


const recursivelyReadBlobsFromLocalDirectory = async (sourcePathInsideLocalDirectory) => {
    let blobs;

    const trailingSlashPresent =  sourcePathInsideLocalDirectory[sourcePathInsideLocalDirectory.length - 1] == '/'
    if (trailingSlashPresent) {
        blobs = [];
    }

    try {
        const stats = await fs.statSync(sourcePathInsideLocalDirectory);

        if (stats.isFile()) {
            try {
                const data = fs.readFileSync(sourcePathInsideLocalDirectory)
                const file = {
                    kind: 'file',
                    name: path.basename(sourcePathInsideLocalDirectory),
                    content: data,
                    contentType: ''
                };
                blobs = file;
            } catch (error) {
                console.error('readFile Error:', error);
            }
        } else if (stats.isDirectory()) {
            try {
                const blobNames = await fs.readdirSync(sourcePathInsideLocalDirectory);
                let this_blobs = []
                for (const blobName of blobNames) {
                    const this_path = `${sourcePathInsideLocalDirectory}/${blobName}`.replace(/\/\//g, '/');
                    this_blobs.push(await recursivelyReadBlobsFromLocalDirectory(this_path));
                }

                if (trailingSlashPresent) {
                    blobs.push(...this_blobs)
                } else {
                    const directory = {
                        kind: 'directory',
                        name: path.basename(sourcePathInsideLocalDirectory),
                        content: this_blobs,
                        contentType: ''
                    }
                    blobs = directory;
                }
            } catch (error) {
                console.error('readdir Error:', error);
            }
        }
    } catch (error) {
        console.error('fs.stat Error:', error);
    }
    return blobs;
}

const recursivelyUploadBlobsToAzure = async (blobs, prefix, success) => {
    if (success == null) {
        success = true;
    }

    for (const item of blobs) {

        if (item.kind === 'file') {
            const content_path = `${prefix}/${item.name}`.replace(/\/\//g, '/');

            const blockBlobClient = blobContainerClient.getBlockBlobClient(content_path);
            const options = { blobHTTPHeaders: { blobContentType: item.contentType } };
            var response = await blockBlobClient.upload(item.content, item.content.length, options);
            success &= Boolean(response);
        } else if (item.kind === 'directory') {
            const this_prefix = `${prefix}/${item.name}/`.replace(/\/\//g, '/');
            const this_content = item.content;
            success &= await recursivelyUploadBlobsToAzure(this_content, this_prefix, success);
        } else {
            success = false;
        }
    }
    return success
}

function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on("data", (data) => {
            chunks.push(data instanceof Buffer ? data : Buffer.from(data));
        });
        readableStream.on("end", () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on("error", reject);
    });
}

const fetchBlobsFromAzureStorage = async (prefix) => {
    const blobs = [];
    const time0 = performance.now()

    const blobIterator = blobContainerClient.listBlobsByHierarchy("/", { prefix });

    for await (const blob of blobIterator) {

        if (blob.kind === "prefix") {
            let this_blobs = await fetchBlobsFromAzureStorage(blob.name); // []
            var words = blob.name.trim().split('/');
            const name = words[words.length - 2];
            const directory = {
                kind: 'directory',
                name,
                content: this_blobs,
                contentType: ''
            }
            blobs.push(directory)
        } else {
            const blockBlobClient = blobContainerClient.getBlockBlobClient(blob.name);
            const downloadResponse = await blockBlobClient.download();
            const contentType = downloadResponse.contentType;
            const bufferData = await streamToBuffer(downloadResponse.readableStreamBody);
            const filePath = blob.name.split('/').slice(3).join('/');
            var words = blob.name.trim().split('/');
            const name = words[words.length - 1];
            const file = {
                kind: 'file',
                name,
                content: bufferData,//.toString(),
                contentType
            };
            blobs.push(file);
        }
    }

    return blobs
}

const fetchFirstLevelBlobsFromAzureStorage = async (prefix) => {
    const blobs = [];
    const time0 = performance.now()

    const blobIterator = blobContainerClient.listBlobsByHierarchy("/", { prefix });

    for await (const blob of blobIterator) {

        if (blob.kind === "prefix") {
            let this_blobs = [];
            var words = blob.name.trim().split('/');
            const name = words[words.length - 2];
            const directory = {
                kind: 'directory',
                name,
                content: this_blobs,
                contentType: ''
            }
            blobs.push(directory)
        } else {
            const blockBlobClient = blobContainerClient.getBlockBlobClient(blob.name);
            const downloadResponse = await blockBlobClient.download();
            const contentType = downloadResponse.contentType;
            const bufferData = await streamToBuffer(downloadResponse.readableStreamBody);
            const filePath = blob.name.split('/').slice(3).join('/');
            var words = blob.name.trim().split('/');
            const name = words[words.length - 1];
            const file = {
                kind: 'file',
                name,
                content: bufferData,//.toString(),
                contentType
            };
            blobs.push(file);
        }
    }

    return blobs
}

const recursivelyWriteBlobsInLocalDirectory = async (blobs, destinationPathInsideLocalDirectory) => {
    for (const blob of blobs) {
        if (blob.kind == 'file') {

            let filePath = `${localDirectory}/${destinationPathInsideLocalDirectory}`

            const destinationIsDirectory = destinationPathInsideLocalDirectory[destinationPathInsideLocalDirectory.length - 1] == '/';

            if (destinationIsDirectory) {
                filePath += `/${blob.name}`
            }

            filePath = filePath.replace(/\/\//g, '/');

            const directoryPath = path.dirname(filePath);

            if (!fs.existsSync(directoryPath)) {
                fs.mkdirSync(directoryPath, { recursive: true });
            }

            fs.writeFileSync(filePath, blob.content, (error) => {
                if (error) {
                    console.error(`Error writing ${filePath}:`, error)
                }
            })
        } else if (blob.kind == 'directory') {
            const newDestinationPathInsideLocalDirectory = destinationPathInsideLocalDirectory + `${blob.name}/`;
            const newBlobs = blob.content;
            await recursivelyWriteBlobsInLocalDirectory(newBlobs, newDestinationPathInsideLocalDirectory);
        }
    }
}

app.post('/fetch-file-from-azure', async (req, res) => {

    let filePath = req.body.path;
    if (filePath[filePath.length - 1] == '/') {
        filePath = filePath.slice(0, filePath.length - 1);
    }

    const token = req.body.token;

    let success = 0;
    let message = 'Error fetching.';
    let code = '';

    try {
        if (token == config.readToken || token == config.writeToken) {
            const blob = (await fetchFirstLevelBlobsFromAzureStorage(filePath))[0];

            if (!blob) {
                success = 0;
                message = 'Path not found';
            } else if (blob.kind == 'directory') {
                success = 0;
                message = 'This path is a directory.';
            } else if (blob.kind == 'file') {
                success = 1;
                message = 'File Sent';
                code = blob.content.toString();
            }
        } else {
            success = 0;
            message = 'Invalid token.';
        }
    } catch (error) {
        success = 0;
        message = error.message;
    }

    res.send({ success, message, data: { code } });
})


app.post('/upload-code-to-azure', async (req, res) => {

    const filePath = req.body.path;
    if (filePath[filePath.length - 1] == '/') {
        filePath = filePath.slice(0, filePath.length - 1);
    }

    const code = req.body.code;
    const token = req.body.token;

    let success = 0;
    let message = 'Error updating.';

    try {
        if (token == config.writeToken) {

            const destinationPathInsideAzureContainer = path.dirname(filePath);
            var words = filePath.trim().split('/');
            const name = words[words.length - 1];
            const blobs = [
                {
                    kind: 'file',
                    name,
                    content: code,
                    contentType: ''
                }
            ]
            var uploadSuccess = await recursivelyUploadBlobsToAzure(blobs, destinationPathInsideAzureContainer);

            if (uploadSuccess) {
                success = 1;
                message = 'Upload successful';
            } else {
                success = 0;
                message = 'Upload NOT successful';
            }
        } else {
            success = 0;
            message = 'Invalid token.';
        }
    } catch (error) {
        success = 0;
        message = error.message;
    }

    res.send({ success, message });
})

app.post('/sync-blobs-azure-to-local', async (req, res) => {
    const sourcePathInsideAzureContainer = req.body.sourcePathInsideAzureContainer;
    const destinationPathInsideLocalDirectory = `${localDirectory}/${req.body.destinationPathInsideLocalDirectory}`.replace(/\/\//g, '/');
    const token = req.body.token;

    try {
        if (token == config.writeToken) {
            let blobs = await fetchBlobsFromAzureStorage(sourcePathInsideAzureContainer);

            await recursivelyWriteBlobsInLocalDirectory(blobs, destinationPathInsideLocalDirectory);

            res.send({ success: 1, message: 'Download completed successfully!' });
        } else {
            res.send({ success: 0, message: 'Invalid token.' });
        }
    } catch (error) {
        res.send({ success: 0, message: error.message });;
    }
});

app.post('/sync-blobs-local-to-azure', async (req, res) => {
    console.log('Syncing blobs local to azure')

    const sourcePathInsideLocalDirectory = `${localDirectory}/${req.body.sourcePathInsideLocalDirectory}`.replace(/\/\//g, '/');
    const destinationPathInsideAzureContainer = req.body.destinationPathInsideAzureContainer;
    const token = req.body.token;

    try {
        if (token == config.writeToken) {
            let blobs = await recursivelyReadBlobsFromLocalDirectory(sourcePathInsideLocalDirectory);
            if (!Array.isArray(blobs)) {
                blobs = [blobs]
            }

            var uploadSuccess = await recursivelyUploadBlobsToAzure(blobs, destinationPathInsideAzureContainer);

            if (uploadSuccess) {
                res.send({ success: 1, message: 'Upload completed successfully!' });
            } else {
                res.send({ success: 0, message: 'Upload NOT successful.' });
            }
        } else {
            res.send({ success: 0, message: 'Invalid token.' });
        }
    } catch (error) {
        res.status(500).send(error);
    }
});

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});

