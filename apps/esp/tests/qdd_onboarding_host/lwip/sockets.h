#pragma once
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#ifndef EWOULDBLOCK
#define EWOULDBLOCK EAGAIN
#endif
typedef unsigned socklen_t;
struct in_addr { uint32_t s_addr; };
struct sockaddr { uint16_t sa_family; char sa_data[14]; };
struct sockaddr_in { uint16_t sin_family, sin_port; struct in_addr sin_addr; char zero[8]; };
#define AF_INET 2
#define SOCK_DGRAM 2
#define IPPROTO_UDP 17
#define INADDR_ANY 0
int qdd_test_socket(int domain, int type, int protocol);
int qdd_test_close(int descriptor);
int qdd_test_bind(int descriptor, const struct sockaddr *address, socklen_t size);
int qdd_test_getpeername(int descriptor, struct sockaddr *address, socklen_t *size);
ssize_t qdd_test_recvfrom(int descriptor, void *bytes, size_t size, int flags, struct sockaddr *address, socklen_t *address_size);
ssize_t qdd_test_sendto(int descriptor, const void *bytes, size_t size, int flags, const struct sockaddr *address, socklen_t address_size);
uint16_t qdd_test_htons(uint16_t value);
uint32_t qdd_test_htonl(uint32_t value);
const char *qdd_test_inet_ntop(int family, const void *source, char *dest, socklen_t size);
#define socket qdd_test_socket
#define close qdd_test_close
#define bind qdd_test_bind
#define getpeername qdd_test_getpeername
#define recvfrom qdd_test_recvfrom
#define sendto qdd_test_sendto
#define htons qdd_test_htons
#define htonl qdd_test_htonl
#define inet_ntop qdd_test_inet_ntop
