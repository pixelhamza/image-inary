package storage

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/aws/smithy-go/logging"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

const (
	SignedURLLifetime = 3 * time.Minute
	maxCiphertextSize = 20*1024*1024 + 29
)

var (
	bucketName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
	regionName = regexp.MustCompile(`^[a-z]{2,8}(-[a-z0-9]+)+-[0-9]+$`)
	objectID   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

type S3 struct {
	client    *s3.Client
	presigner *s3.PresignClient
	bucket    string
}

var _ Store = (*S3)(nil)

// On EC2, leave static AWS credentials unset so the SDK uses the instance role.
// This loads configuration but does not create or probe AWS resources.
func NewS3(ctx context.Context, bucket, region string) (*S3, error) {
	if !validBucket(bucket) || !regionName.MatchString(region) {
		return nil, ErrInvalidRequest
	}
	config, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithLogger(logging.Nop{}))
	if err != nil {
		return nil, ErrUnavailable
	}
	config.ClientLogMode = 0 // Never log presigned URLs, credentials, or request bodies.
	client := s3.NewFromConfig(config, func(options *s3.Options) {
		options.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
	})
	return newS3(client, bucket), nil
}

func validBucket(bucket string) bool {
	return bucketName.MatchString(bucket) && !strings.HasPrefix(bucket, "xn--") &&
		!strings.HasPrefix(bucket, "sthree-") && !strings.HasPrefix(bucket, "amzn-s3-demo-") &&
		!strings.HasSuffix(bucket, "--ol-s3") && !strings.HasSuffix(bucket, "--x-s3")
}

func newS3(client *s3.Client, bucket string) *S3 {
	return &S3{client: client, presigner: s3.NewPresignClient(client, func(options *s3.PresignOptions) {
		options.Expires = SignedURLLifetime
	}), bucket: bucket}
}

func objectKey(id string) (string, error) {
	if !objectID.MatchString(id) {
		return "", ErrInvalidRequest
	}
	return "ciphertext/" + id, nil
}

func browserURL(signed *v4.PresignedHTTPRequest) (SignedURL, error) {
	parsed, err := url.Parse(signed.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return SignedURL{}, ErrUnavailable
	}
	date, err := time.Parse("20060102T150405Z", parsed.Query().Get("X-Amz-Date"))
	if err != nil || parsed.Query().Get("X-Amz-Expires") != "180" {
		return SignedURL{}, ErrUnavailable
	}
	headers := make(map[string]string)
	for name, values := range signed.SignedHeader {
		// Browsers set these forbidden headers themselves, including the actual
		// ciphertext Content-Length, which remains bound by the signature.
		if strings.EqualFold(name, "Host") || strings.EqualFold(name, "Content-Length") {
			continue
		}
		headers[http.CanonicalHeaderKey(name)] = strings.Join(values, ",")
	}
	return SignedURL{URL: signed.URL, Headers: headers, ExpiresAt: date.Add(SignedURLLifetime)}, nil
}

func (s *S3) SignPut(ctx context.Context, id string, size int64) (SignedURL, error) {
	key, err := objectKey(id)
	if err != nil || size < 30 || size > maxCiphertextSize {
		return SignedURL{}, ErrInvalidRequest
	}
	signed, err := s.presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), ContentLength: aws.Int64(size),
		ContentType: aws.String(CiphertextContentType), ServerSideEncryption: types.ServerSideEncryptionAes256,
	})
	if err != nil {
		return SignedURL{}, ErrUnavailable
	}
	result, err := browserURL(signed)
	if err != nil {
		return SignedURL{}, err
	}
	result.Headers["Content-Type"] = CiphertextContentType
	return result, nil
}

func (s *S3) SignGet(ctx context.Context, id string) (SignedURL, error) {
	key, err := objectKey(id)
	if err != nil {
		return SignedURL{}, err
	}
	signed, err := s.presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key),
		ResponseContentType: aws.String(CiphertextContentType), ResponseContentDisposition: aws.String("attachment"),
	})
	if err != nil {
		return SignedURL{}, ErrUnavailable
	}
	return browserURL(signed)
}

func (s *S3) Head(ctx context.Context, id string) (ObjectInfo, error) {
	key, err := objectKey(id)
	if err != nil {
		return ObjectInfo{}, err
	}
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return ObjectInfo{}, classifyS3(err)
	}
	if result.ContentLength == nil || *result.ContentLength < 0 {
		return ObjectInfo{}, ErrUnavailable
	}
	return ObjectInfo{Size: *result.ContentLength, ContentType: aws.ToString(result.ContentType)}, nil
}

func (s *S3) Delete(ctx context.Context, id string) error {
	key, err := objectKey(id)
	if err != nil {
		return err
	}
	_, err = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	classified := classifyS3(err)
	if errors.Is(classified, ErrNotFound) {
		return nil
	}
	return classified
}

func classifyS3(err error) error {
	if err == nil {
		return nil
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		switch apiError.ErrorCode() {
		case "NoSuchBucket":
			return ErrUnavailable
		case "NoSuchKey", "NotFound":
			return ErrNotFound
		}
	}
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) && responseError.HTTPStatusCode() == http.StatusNotFound {
		return ErrNotFound
	}
	// Without ListBucket permission a missing object's HEAD may be 403, not 404.
	// Do not misreport access denial as absence or leak SDK URLs/error details.
	return ErrUnavailable
}
