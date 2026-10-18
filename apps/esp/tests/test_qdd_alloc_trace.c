#include "qdd_alloc_trace.h"
#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static bool fail;
static unsigned calls;
static size_t last_size,last_count;
static uint32_t last_caps;
static uint8_t sentinel;
void *__real_malloc(size_t size) { calls++; last_size=size; errno=fail?ENOMEM:0; return fail?NULL:&sentinel; }
void *__real_calloc(size_t count,size_t size) { calls++; last_count=count; last_size=size; errno=fail?ENOMEM:0; return fail?NULL:&sentinel; }
void *__real_heap_caps_malloc(size_t size,uint32_t caps) { calls++; last_size=size; last_caps=caps; errno=fail?ENOMEM:0; return fail?NULL:&sentinel; }
// Include production wrappers so mocks remain defined in the same object.
// A separate object proves GNU ld rewrites an external function pointer.
#include "../main/qdd_alloc_trace.c"
void *qdd_alloc_pointer_probe(size_t size,uint32_t caps);
static void snapshot(char out[QDD_ALLOC_TRACE_MAX+1]) {
  assert(qdd_alloc_trace_diagnostics(out,QDD_ALLOC_TRACE_MAX+1)==strlen(out));
  assert(strlen(out)<=QDD_ALLOC_TRACE_MAX);
}
static uintptr_t pc(const char *out) {
  const char *at=strstr(out,"\"pc\":"); assert(at); uintptr_t value=0;
  assert(sscanf(at+5,"%" SCNuPTR,&value)==1); return value;
}
int main(int argc,char **argv) {
  assert(argc==2); char out[QDD_ALLOC_TRACE_MAX+1]; snapshot(out);
  assert(strstr(out,"\"count\":0") && strstr(out,"\"ready\":false") && !pc(out));
  assert(!qdd_alloc_trace_diagnostics(NULL,12));
  char tiny[3]={'x','y','z'};
  assert(!qdd_alloc_trace_diagnostics(tiny+1,1) && tiny[0]=='x' && tiny[1]==0 && tiny[2]=='z');
  assert(!qdd_alloc_trace_diagnostics(tiny,0) && tiny[0]=='x');
  if(!strcmp(argv[1],"success")) {
    assert(__wrap_malloc(1700)==&sentinel && calls==1 && last_size==1700);
    assert(__wrap_calloc(2,850)==&sentinel && calls==2 && last_count==2 && last_size==850);
    assert(qdd_alloc_pointer_probe(1700,6144)==&sentinel && calls==3 && last_caps==6144);
    snapshot(out); assert(strstr(out,"\"count\":0") && !pc(out));
  } else if(!strcmp(argv[1],"zero")) {
    fail=true; assert(!__wrap_malloc(0) && !__wrap_calloc(0,1700) && !__wrap_calloc(1700,0));
    assert(!qdd_alloc_pointer_probe(0,6144) && calls==4);
    snapshot(out); assert(strstr(out,"\"count\":0") && !pc(out));
  } else {
    fail=true;
    if(!strcmp(argv[1],"malloc")) { assert(!__wrap_malloc(1700)); snapshot(out); assert(strstr(out,"\"kind\":1") && strstr(out,"\"size\":1700") && strstr(out,"\"caps\":0")); }
    else if(!strcmp(argv[1],"calloc")) { assert(!__wrap_calloc(2,850)); snapshot(out); assert(strstr(out,"\"kind\":2") && strstr(out,"\"size\":1700") && strstr(out,"\"caps\":0")); }
    else if(!strcmp(argv[1],"caps")) { assert(!qdd_alloc_pointer_probe(1700,6144)); snapshot(out); assert(strstr(out,"\"kind\":3") && strstr(out,"\"size\":1700") && strstr(out,"\"caps\":6144")); }
    else { assert(!strcmp(argv[1],"overflow")); assert(!__wrap_calloc(SIZE_MAX,2)); snapshot(out); assert(strstr(out,"\"kind\":2") && strstr(out,"\"size\":4294967295")); }
    assert(errno==ENOMEM && calls==1 && strstr(out,"\"count\":1") && strstr(out,"\"ready\":true") && pc(out));
    const uintptr_t first_pc=pc(out); const unsigned first_kind=atomic_load(&s_kind),first_size=atomic_load(&s_size),first_caps=atomic_load(&s_caps);
    assert(!__wrap_malloc(1630) && !qdd_alloc_pointer_probe(1630,2060) && calls==3);
    snapshot(out); assert(strstr(out,"\"count\":3") && pc(out)==first_pc);
    assert(atomic_load(&s_kind)==first_kind && atomic_load(&s_size)==first_size && atomic_load(&s_caps)==first_caps);
    fail=false; assert(__wrap_malloc(6)==&sentinel && calls==4);
    snapshot(out); assert(strstr(out,"\"count\":3") && pc(out)==first_pc);
  }
  puts("QDD allocator wrapper unchanged results/errno, first failure, GNU pointer relocation and bounded JSON: PASS");
  return 0;
}
