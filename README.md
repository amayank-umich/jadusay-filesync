
## Usage
- Download azure src jsx files to local directory of `jadusay-webapp`
`curl -X POST http://localhost:3010/sync-blobs-azure-to-local -H 'Content-Type: application/json' -d '{"sourcePathInsideAzureContainer": "src", "destinationPathInsideLocalDirectory": ""}'`

- Upload build directory from local directory to azure
`curl -X POST http://localhost:3010/sync-blobs-lo application/json' -d '{"sourcePathInsideLocalDirectory": "public/build/", "destinationPathInsideAzureContainer": "build/"}'`