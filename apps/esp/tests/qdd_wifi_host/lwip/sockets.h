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
#define SOCK_STREAM 1
#define IPPROTO_TCP 6
#define SOL_SOCKET 1
#define SO_REUSEADDR 2
#define MSG_DONTWAIT 0x40

int qdd_test_socket(int domain, int type, int protocol);
int qdd_test_close(int descriptor);
int qdd_test_setsockopt(int descriptor, int level, int option, const void *value, socklen_t size);
int qdd_test_bind(int descriptor, const struct sockaddr *address, socklen_t size);
int qdd_test_listen(int descriptor, int backlog);
int qdd_test_accept(int descriptor, struct sockaddr *address, socklen_t *size);
ssize_t qdd_test_recv(int descriptor, void *bytes, size_t size, int flags);
ssize_t qdd_test_send(int descriptor, const void *bytes, size_t size, int flags);
uint16_t qdd_test_htons(uint16_t value);
uint32_t qdd_test_ntohl(uint32_t value);
const char *qdd_test_inet_ntop(int family, const void *source, char *dest, socklen_t size);

#define socket qdd_test_socket
#define close qdd_test_close
#define setsockopt qdd_test_setsockopt
#define bind qdd_test_bind
#define listen qdd_test_listen
#define accept qdd_test_accept
#define recv qdd_test_recv
#define send qdd_test_send
#define htons qdd_test_htons
#define ntohl qdd_test_ntohl
#define inet_ntop qdd_test_inet_ntop
