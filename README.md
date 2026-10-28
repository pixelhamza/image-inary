# Imageinary  : D : D

A cloud-native, end-to-end encrypted photo gallery built with React, Go, and AWS.

Imageinary lets you securely upload, store, view, and download your photos. Images are encrypted locally before reaching the cloud, keeping your memories private.

## Tech Stack

- **Frontend:** React, TypeScript, Vite
- **Backend:** Go, Chi
- **Encryption:** Web Crypto API (AES-256-GCM)
- **Database:** PostgreSQL (AWS RDS)
- **Storage:** Amazon S3
- **Deployment:** AWS EC2, Docker
- **Cloud Security:** IAM, VPC, HTTPS

(soon to be REFURNISHED)

## Features

- Client-side photo encryption and decryption
- Secure cloud photo storage
- Private gallery with image previews
- Upload, download, and delete photos
- Support for PNG, JPG, JPEG, and GIF
- Encrypted thumbnails and metadata

## Architecture

```text
React + Web Crypto
        |
        v
Go + Chi Backend (EC2)
        |
        +---- PostgreSQL (RDS)
        |
        +---- Amazon S3
              Encrypted Media
```

Media is encrypted in the browser and transferred directly to private S3 storage using presigned URLs. The backend manages metadata and access without needing plaintext photos or vault encryption keys.

## Project Status

 Under development — AWS Cloud Computing LA2 project.

## License

To be decided.

